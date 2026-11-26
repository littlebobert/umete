import Combine
import SwiftUI

/// The iOS app: Umete's settings in standard controls, a tab bar of grouped forms
/// that follow the system text size. It reads and writes the same stores as the
/// Safari extension; the Mac app has its own AppKit settings.
struct SettingsView: View {
    @StateObject private var model = SettingsModel()

    var body: some View {
        TabView {
            GeneralTab()
                .tabItem { Label("General", systemImage: "gearshape") }
            AIMatchingTab()
                .tabItem { Label("AI Matching", systemImage: "sparkles") }
            SavedDataTab()
                .tabItem { Label("Saved Data", systemImage: "tray.full") }
            PrivacyTab()
                .tabItem { Label("Privacy", systemImage: "hand.raised") }
        }
        .environmentObject(model)
        .task { await model.load() }
        .onReceive(NotificationCenter.default.publisher(for: CloudSync.didApplyRemoteChanges)) { _ in
            Task { await model.load() }
        }
        .onReceive(NotificationCenter.default.publisher(for: CloudSync.didFinishSync)) { _ in
            Task { await model.load() }
        }
        .fullScreenCover(isPresented: $model.needsOnboarding) {
            OnboardingView().environmentObject(model)
        }
        .alert(model.alert?.title ?? "", isPresented: $model.showsAlert, presenting: model.alert) { _ in
            Button("OK", role: .cancel) {}
        } message: { alert in
            Text(alert.message)
        }
    }
}

// MARK: - Model

struct SavedAnswer: Identifiable {
    let id: String
    let label: String
    let value: String
    /// The value as typed when it is plain text, which the app can edit; addresses,
    /// contacts, and yes-or-no answers are shown but edited on the Mac.
    let text: String?
    let type: String
    /// A passport's parts, which the app edits in its own sheet.
    let passport: [String: Any]?
}

/// A passport being added or edited; a nil answerID means a new one.
struct PassportEdit: Identifiable {
    let answerID: String?
    let label: String
    let passport: [String: Any]
    var id: String { answerID ?? "new-passport" }
}

/// An answer being added or edited in the sheet; a nil answerID means a new one.
struct AnswerEdit: Identifiable {
    let answerID: String?
    let label: String
    let value: String
    var type = ""
    var id: String { answerID ?? "new" }
}

/// The types a plain text answer can have; passports have their own sheet, and
/// addresses and contacts are added on the Mac.
private let textAnswerTypes = [
    ("", String(localized: "Default", comment: "Answer type: plain text with no special format")),
    ("date", String(localized: "Date", comment: "Answer type")),
    ("gender", String(localized: "Gender", comment: "Answer type")),
    ("phone", String(localized: "Phone", comment: "Answer type: phone number"))
]

enum AIProvider: String, CaseIterable, Identifiable {
    case umete, openai, anthropic
    case openAIDecisions = "openai-decisions"

    var id: String { rawValue }

    var name: String {
        switch self {
        case .umete: return String(localized: "Umete (free)", comment: "AI provider: Umete's free matching service")
        case .openai: return "OpenAI"
        case .anthropic: return "Anthropic"
        case .openAIDecisions: return "OpenAI"
        }
    }

    /// The Provider menu's entries; OpenAI's two APIs are modes under one entry.
    static let menuChoices: [AIProvider] = [.umete, .openai, .anthropic]
    var menuChoice: AIProvider { self == .openAIDecisions ? .openai : self }
    var modeName: String {
        self == .openAIDecisions
            ? "Decisions API"
            : String(localized: "GPT-6.1 Sol (medium, fast)", comment: "OpenAI mode: model name (keep as is), medium reasoning effort, fast service tier")
    }

    var defaultModel: String {
        switch self {
        case .umete: return ""
        case .openai: return SafariWebExtensionHandlerProviders.iOSOpenAIModel
        case .anthropic: return "claude-opus-5"
        case .openAIDecisions: return "gpt-6-luna"
        }
    }

    var needsKey: Bool { SafariWebExtensionHandlerProviders.requiresKey(rawValue) }
}

@MainActor
final class SettingsModel: ObservableObject {
    struct Alert {
        let title: String
        let message: String
    }

    @Published var provider: AIProvider = .umete
    @Published var modelName = ""
    @Published var apiKeyDraft = ""
    @Published private(set) var hasKey = false
    @Published private(set) var answers: [SavedAnswer] = []
    @Published var syncEnabled = CloudSync.isEnabled
    @Published private(set) var syncStatus = String(localized: "Checking iCloud…")
    @Published private(set) var isSyncing = false
    @Published var needsOnboarding = false
    @Published private(set) var debugLoggingEnabled = AIDebugLogStore.isEnabled
    @Published private(set) var hidesSensitiveDebugInfo = AIDebugLogStore.hidesSensitiveInfo
    @Published var showsAlert = false
    private(set) var alert: Alert?

    func load() async {
        let settings = SettingsStore.load()
        provider = AIProvider(rawValue: settings?.provider ?? "") ?? .umete
        // Only Anthropic's model can be typed; OpenAI's follows its mode.
        modelName = provider == .anthropic && settings?.model.isEmpty == false ? settings!.model : provider.defaultModel
        hasKey = !(settings?.apiKey.isEmpty ?? true)
        needsOnboarding = !OnboardingStore.isComplete
        answers = ((try? AnswerStore.load()) ?? []).enumerated().map { index, answer in
            SavedAnswer(
                id: answer["answerID"] as? String ?? "answer-\(index)",
                label: Self.label(of: answer, index: index),
                value: Self.valueText(of: answer, label: Self.label(of: answer, index: index)),
                text: answer["value"] as? String,
                type: answer["answerType"] as? String ?? "",
                passport: answer["answerType"] as? String == "passport" ? answer["value"] as? [String: Any] : nil
            )
        }
        syncEnabled = CloudSync.isEnabled
        debugLoggingEnabled = AIDebugLogStore.isEnabled
        hidesSensitiveDebugInfo = AIDebugLogStore.hidesSensitiveInfo
        syncStatus = await CloudSync.shared.statusDescription()
    }

    func chooseProvider(_ newValue: AIProvider) {
        if modelName.isEmpty || AIProvider.allCases.contains(where: { $0.defaultModel == modelName }) {
            modelName = newValue.defaultModel
        }
        provider = newValue
        // The free service needs nothing else, so it applies at once, like a setting
        // in Settings; providers with a key wait for Save.
        if !newValue.needsKey && !needsOnboarding {
            Task { await saveSettings(quietly: true) }
        }
    }

    /// Saves the provider, model, and (when typed) a new key. Returns whether it saved.
    @discardableResult
    func saveSettings(completingOnboarding: Bool = false, quietly: Bool = false) async -> Bool {
        let model = provider == .anthropic ? modelName.trimmingCharacters(in: .whitespacesAndNewlines) : provider.defaultModel
        let typedKey = apiKeyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = typedKey.isEmpty ? SettingsStore.load()?.apiKey ?? "" : typedKey
        guard !provider.needsKey || (!model.isEmpty && !key.isEmpty) else {
            show(String(localized: "Missing Details"), provider == .anthropic
                ? String(localized: "Enter a model and an API key for \(provider.name), or choose Umete (free).")
                : String(localized: "Enter an API key for \(provider.name), or choose Umete (free)."))
            return false
        }
        do {
            // The free service ignores the model; any saved key is kept for switching back.
            try SettingsStore.save(AISettings(provider: provider.rawValue, model: provider.needsKey ? model : "", apiKey: key))
            if completingOnboarding { OnboardingStore.isComplete = true }
            apiKeyDraft = ""
            await load()
            if !completingOnboarding && !quietly {
                show(String(localized: "Saved", comment: "Alert title after AI settings are saved"), String(localized: "Your AI settings are stored securely in Apple Keychain."))
            }
            return true
        } catch {
            show(String(localized: "Couldn’t Save"), error.localizedDescription)
            return false
        }
    }

    func deleteKey() async {
        SettingsStore.delete()
        await load()
        show(String(localized: "Key Deleted"), String(localized: "The saved API key was deleted."))
    }

    /// Adds a text answer, or changes one's label and value. Returns a message when
    /// it could not be saved, for the sheet to show.
    func save(_ edit: AnswerEdit) async -> String? {
        let label = edit.label.trimmingCharacters(in: .whitespacesAndNewlines)
        let value = edit.value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty, !value.isEmpty else { return String(localized: "Enter both a label and a value.") }
        do {
            if let id = edit.answerID {
                try AnswerStore.update(id: id, userLabel: label, value: value, answerType: edit.type)
            } else {
                try AnswerStore.add(userLabel: label, value: value, answerType: edit.type)
            }
        } catch {
            return error.localizedDescription
        }
        await load()
        return nil
    }

    /// Adds or changes a passport. Returns a message when it could not be saved.
    func savePassport(answerID: String?, label: String, passport: [String: Any]) async -> String? {
        do {
            if let answerID {
                try AnswerStore.updatePassport(id: answerID, userLabel: label, value: passport)
            } else {
                try AnswerStore.addPassport(userLabel: label, value: passport)
            }
        } catch {
            return error.localizedDescription
        }
        await load()
        return nil
    }

    func delete(at offsets: IndexSet) async {
        do {
            for index in offsets { try AnswerStore.delete(id: answers[index].id) }
        } catch {
            show(String(localized: "Couldn’t Delete"), String(localized: "Umete could not delete that answer."))
        }
        await load()
    }

    func clearAnswers() async {
        do {
            try AnswerStore.clear()
            show(String(localized: "Answers Deleted"), CloudSync.isEnabled
                ? String(localized: "All saved answers were deleted from this device and will be removed from your other devices. Your AI settings were kept.")
                : String(localized: "All saved answers were deleted. Your AI settings were kept."))
        } catch {
            show(String(localized: "Couldn’t Delete"), String(localized: "Umete could not delete all saved answers."))
        }
        await load()
    }

    func setSyncEnabled(_ enabled: Bool) async {
        CloudSync.isEnabled = enabled
        syncEnabled = enabled
        if enabled { await syncNow() } else { await load() }
    }

    /// Turning logging off deletes what it saved, as on the Mac.
    func setDebugLogging(_ enabled: Bool) {
        AIDebugLogStore.isEnabled = enabled
        debugLoggingEnabled = enabled
        guard !enabled else { return }
        do {
            try AIDebugLogStore.clear()
        } catch {
            show(String(localized: "Couldn’t Delete"), String(localized: "Logging disabled, but saved logs could not be deleted: \(error.localizedDescription)", comment: "The placeholder is an error message"))
        }
    }

    func setHidesSensitiveDebugInfo(_ hides: Bool) {
        AIDebugLogStore.hidesSensitiveInfo = hides
        hidesSensitiveDebugInfo = hides
    }

    func syncNow() async {
        isSyncing = true
        syncStatus = String(localized: "Syncing…")
        do {
            _ = try await CloudSync.shared.sync(reason: .manual)
        } catch {
            // The status below explains what went wrong, such as no iCloud account.
        }
        isSyncing = false
        await load()
    }

    private func show(_ title: String, _ message: String) {
        alert = Alert(title: title, message: message)
        showsAlert = true
    }

    private static func label(of answer: [String: Any], index: Int) -> String {
        for key in ["userLabel", "accessibleName", "label", "placeholder", "name", "autocomplete"] {
            if let text = answer[key] as? String, !text.isEmpty { return text }
        }
        return String(localized: "Saved answer \(index + 1)", comment: "Fallback label for a saved answer with no label; the number is its position in the list")
    }

    private static func valueText(of answer: [String: Any], label: String) -> String {
        switch answer["value"] {
        case let flag as Bool:
            return flag
                ? String(localized: "Yes", comment: "Value of a saved yes-or-no answer")
                : String(localized: "No", comment: "Value of a saved yes-or-no answer")
        case let parts as [String: Any] where answer["answerType"] as? String == "passport":
            return AnswerStore.passportSummary(parts)
        case let parts as [String: Any]:
            let isAddress = answer["answerType"] as? String == "address"
            let keys = isAddress
                ? ["addressLine1", "addressLine2", "locality", "administrativeArea", "postalCode", "countryName"]
                : ["name", "role", "phone"]
            // A contact's label is usually its name already; don't say it twice.
            return keys.compactMap { parts[$0] as? String }
                .filter { !$0.isEmpty && !(!isAddress && $0 == label) }
                .joined(separator: isAddress ? ", " : " · ")
        case let text as String:
            return text
        case let number as NSNumber:
            return number.stringValue
        default:
            return ""
        }
    }
}

// MARK: - Shared pieces

/// The app's icon, sized with the text so it grows with larger text sizes.
struct AppIconImage: View {
    @ScaledMetric private var size: CGFloat
    init(size: CGFloat) { _size = ScaledMetric(wrappedValue: size, relativeTo: .title) }

    var body: some View {
        Image("LargeIcon")
            .resizable()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.225, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: size * 0.225, style: .continuous).stroke(Color.primary.opacity(0.08)))
            .accessibilityHidden(true)
    }
}

/// The provider, model, and key fields, shared by onboarding and the AI tab.
struct ProviderFields: View {
    @EnvironmentObject private var model: SettingsModel

    var body: some View {
        Picker("Provider", selection: Binding(get: { model.provider.menuChoice }, set: { choice in
            if choice != model.provider.menuChoice { model.chooseProvider(choice) }
        })) {
            ForEach(AIProvider.menuChoices) { Text($0.name).tag($0) }
        }
        if model.provider.menuChoice == .openai {
            Picker("Mode", selection: Binding(get: { model.provider }, set: { model.chooseProvider($0) })) {
                ForEach([AIProvider.openai, .openAIDecisions]) { Text($0.modeName).tag($0) }
            }
        }
        if model.provider == .anthropic {
            TextField("Model", text: $model.modelName)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        if model.provider.needsKey {
            SecureField(model.hasKey ? String(localized: "API key (saved)") : String(localized: "API key"), text: $model.apiKeyDraft)
                .textContentType(.password)
        }
    }
}

// MARK: - Tabs

struct GeneralTab: View {
    @EnvironmentObject private var model: SettingsModel
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        NavigationView {
            Form {
                Section {
                    // The icon beside the name, or above it at accessibility text sizes.
                    if typeSize.isAccessibilitySize {
                        VStack(alignment: .leading, spacing: 8) { AppIconImage(size: 60); identity }
                            .padding(.vertical, 4)
                    } else {
                        HStack(spacing: 14) { AppIconImage(size: 60); identity }
                            .padding(.vertical, 4)
                    }
                }
                Section {
                    Text("Turn on Umete in Settings → Apps → Safari → Extensions, then open it from Safari’s page menu on a form.")
                } header: {
                    Text("Safari Extension")
                }
                Section {
                    Toggle("Sync with iCloud", isOn: Binding(get: { model.syncEnabled }, set: { enabled in
                        Task { await model.setSyncEnabled(enabled) }
                    }))
                    Button {
                        Task { await model.syncNow() }
                    } label: {
                        HStack {
                            Text("Sync Now")
                            if model.isSyncing { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(!model.syncEnabled || model.isSyncing)
                } header: {
                    Text("iCloud")
                } footer: {
                    Text("\(model.syncStatus) Answers are encrypted on your devices with a key in your iCloud Keychain, so Apple can’t read them.")
                }
                Section {
                    Text("Umete matches fields on your device first. AI matching is used only for fields it can’t match itself.")
                } header: {
                    Text("How Umete Fills Forms")
                }
                Section {
                    Link("Get Umete for Mac", destination: URL(string: "https://umete.jp")!)
                } footer: {
                    Text("Add addresses and contacts on the Mac. Saved answers sync through iCloud; AI settings stay on each device.")
                }
            }
            .navigationTitle("General")
        }
        .navigationViewStyle(.stack)
    }

    private var identity: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Umete").font(.title2.weight(.semibold))
            Text("Fills in web forms in Safari, with answers you’ve saved.")
                .font(.subheadline)
                .foregroundColor(.secondary)
        }
    }
}

struct AIMatchingTab: View {
    @EnvironmentObject private var model: SettingsModel
    @State private var confirmsKeyDeletion = false

    var body: some View {
        NavigationView {
            Form {
                Section {
                    ProviderFields()
                } footer: {
                    Text(model.provider.needsKey
                        ? (model.provider == .openai
                            ? String(localized: "Your key is stored in Apple Keychain on this device. It isn’t synced. Fast mode costs twice OpenAI’s standard rate.")
                            : String(localized: "Your key is stored in Apple Keychain on this device. It isn’t synced."))
                        : String(localized: "Free, with a daily limit. No key needed."))
                }
                if model.provider.needsKey {
                    Section {
                        Button("Save") { Task { await model.saveSettings() } }
                    }
                }
                if model.hasKey {
                    Section {
                        Button("Delete Saved Key", role: .destructive) { confirmsKeyDeletion = true }
                    }
                }
                Section {
                    Toggle("Enable logging for bug reports", isOn: Binding(
                        get: { model.debugLoggingEnabled }, set: { model.setDebugLogging($0) }))
                    if model.debugLoggingEnabled {
                        Toggle("Hide potentially sensitive info in AI debug logs", isOn: Binding(
                            get: { model.hidesSensitiveDebugInfo }, set: { model.setHidesSensitiveDebugInfo($0) }))
                        NavigationLink(destination: DebugLogView()) { Text("AI Debug Log") }
                    }
                } footer: {
                    if model.debugLoggingEnabled {
                        Text("Your logs are never sent automatically. Open Debug Logs… in the Safari extension to review or email them.")
                    }
                }
            }
            .navigationTitle("AI Matching")
            .confirmationDialog("Delete the saved API key?", isPresented: $confirmsKeyDeletion, titleVisibility: .visible) {
                Button("Delete Key", role: .destructive) { Task { await model.deleteKey() } }
            }
        }
        .navigationViewStyle(.stack)
    }
}

struct SavedDataTab: View {
    @EnvironmentObject private var model: SettingsModel
    @State private var confirmsClear = false
    @State private var editing: AnswerEdit?
    @State private var editingPassport: PassportEdit?

    var body: some View {
        NavigationView {
            List {
                Section {
                    if model.answers.isEmpty {
                        Text("Use Remember my answers on a completed form in Safari, or tap + to add an answer here.")
                            .foregroundColor(.secondary)
                    }
                    ForEach(model.answers) { answer in
                        if let passport = answer.passport {
                            Button {
                                editingPassport = PassportEdit(answerID: answer.id, label: answer.label, passport: passport)
                            } label: {
                                AnswerRow(answer: answer)
                            }
                            .accessibilityHint("Edits this passport")
                        } else if let text = answer.text {
                            Button {
                                editing = AnswerEdit(answerID: answer.id, label: answer.label, value: text, type: answer.type)
                            } label: {
                                AnswerRow(answer: answer)
                            }
                            .accessibilityHint("Edits this answer")
                        } else {
                            AnswerRow(answer: answer)
                        }
                    }
                    .onDelete { offsets in Task { await model.delete(at: offsets) } }
                } footer: {
                    if !model.answers.isEmpty {
                        Text("\(model.answers.count) saved answers, encrypted. Tap an answer to edit it.")
                    }
                }
                if !model.answers.isEmpty {
                    Section {
                        Button("Clear All Answers…", role: .destructive) { confirmsClear = true }
                    } footer: {
                        Text("Deletes every saved answer and keeps your AI settings.")
                    }
                }
            }
            .navigationTitle("Saved Data")
            .toolbar {
                Menu {
                    Button("Text Answer") {
                        editing = AnswerEdit(answerID: nil, label: "", value: "")
                    }
                    Button("Passport") {
                        editingPassport = PassportEdit(answerID: nil, label: "", passport: [:])
                    }
                } label: {
                    Label("Add Answer", systemImage: "plus")
                }
            }
            .sheet(item: $editing) { edit in
                AnswerEditorSheet(edit: edit).environmentObject(model)
            }
            .sheet(item: $editingPassport) { edit in
                PassportEditorSheet(edit: edit).environmentObject(model)
            }
            .refreshable { await model.load() }
            .confirmationDialog(
                model.syncEnabled
                    ? String(localized: "Delete every saved answer on all your devices?")
                    : String(localized: "Delete every saved answer on this device?"),
                isPresented: $confirmsClear,
                titleVisibility: .visible
            ) {
                Button("Delete All Answers", role: .destructive) { Task { await model.clearAnswers() } }
            } message: {
                Text("Your AI settings and API key are kept. This can’t be undone.")
            }
        }
        .navigationViewStyle(.stack)
    }
}

/// The AI matching log the Safari extension writes while logging for bug reports is
/// on: what the Mac's View Log… window shows.
struct DebugLogView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var log = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(AIDebugLogStore.hidesSensitiveInfo
                    ? String(localized: "Sensitive field details are hidden. Saved answer values and API keys are never logged.")
                    : String(localized: "This log may contain field labels and other potentially sensitive form details, but never saved answer values or API keys."))
                    .font(.footnote)
                    .foregroundColor(.secondary)
                Text(log.isEmpty ? Self.emptyMessage : log)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !log.isEmpty {
                    Button("Delete Log", role: .destructive) {
                        try? AIDebugLogStore.clear()
                        dismiss()
                    }
                    .padding(.top, 8)
                }
            }
            .padding()
        }
        .navigationTitle("AI Debug Log")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button("Copy") { UIPasteboard.general.string = log }
                .disabled(log.isEmpty)
        }
        .onAppear { log = AIDebugLogStore.read() }
    }

    private static var emptyMessage: String {
        if let error = AIDebugLogStore.lastError {
            return String(localized: "Umete attempted to write the AI debug log, but it failed:\n\n\(error)", comment: "The placeholder is an error message")
        }
        if let attempt = AIDebugLogStore.lastAttempt {
            return String(localized: "Umete attempted to write the AI debug log at \(attempt.formatted()), but no entries could be read.", comment: "The placeholder is a date and time")
        }
        return String(localized: "No AI debug request has reached the native extension yet.")
    }
}

/// A saved answer's label over its value, as the list shows it.
struct AnswerRow: View {
    let answer: SavedAnswer

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(answer.label).font(.subheadline).foregroundColor(.secondary)
            Text(answer.value).foregroundColor(.primary)
        }
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// Adds or edits a text answer. The value is a text view, so a list, like
/// medications, can go on several lines.
struct AnswerEditorSheet: View {
    @EnvironmentObject private var model: SettingsModel
    @Environment(\.dismiss) private var dismiss
    private let answerID: String?
    @State private var label: String
    @State private var value: String
    @State private var type: String
    @State private var problem: String?
    @State private var isSaving = false

    init(edit: AnswerEdit) {
        answerID = edit.answerID
        _label = State(initialValue: edit.label)
        _value = State(initialValue: edit.value)
        _type = State(initialValue: edit.type)
    }

    private var valueHint: String {
        switch type {
        case "date": return String(localized: "Year, month, and day, like 1990-04-12.")
        case "gender": return String(localized: "As you’d answer on a form, like Female.")
        case "phone": return String(localized: "With the country code, like +81 90-1234-5678.")
        default: return String(localized: "For a list, put each item on its own line.")
        }
    }

    private var canSave: Bool {
        !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationView {
            Form {
                Section {
                    TextField("Label", text: $label)
                } header: {
                    Text("Label")
                } footer: {
                    Text("What a form calls it, like Medications or Passport number.")
                }
                Section {
                    Picker("Type", selection: $type) {
                        ForEach(textAnswerTypes, id: \.0) { Text($0.1).tag($0.0) }
                    }
                }
                Section {
                    TextEditor(text: $value)
                        .frame(minHeight: 140)
                } header: {
                    Text("Value")
                } footer: {
                    Text(valueHint)
                }
                if let problem {
                    Section { Text(problem).foregroundColor(.red) }
                }
            }
            .navigationTitle(answerID == nil ? String(localized: "New Answer") : String(localized: "Edit Answer"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(!canSave || isSaving)
                }
            }
        }
        .navigationViewStyle(.stack)
    }

    private func save() async {
        isSaving = true
        problem = await model.save(AnswerEdit(answerID: answerID, label: label, value: value, type: type))
        isSaving = false
        if problem == nil { dismiss() }
    }
}

/// Adds or edits a passport: its number, countries, and dates, which Fill puts
/// in a form's passport fields one by one.
struct PassportEditorSheet: View {
    @EnvironmentObject private var model: SettingsModel
    @Environment(\.dismiss) private var dismiss
    private let answerID: String?
    @State private var label: String
    @State private var number: String
    @State private var issuingCountry: String
    @State private var nationality: String
    @State private var issueDate: Date?
    @State private var expirationDate: Date?
    @State private var problem: String?
    @State private var isSaving = false
    private let regions = AnswerStore.regionChoices()

    init(edit: PassportEdit) {
        answerID = edit.answerID
        let passport = edit.passport
        let region = edit.answerID == nil ? (Locale.current.regionCode ?? "") : ""
        _label = State(initialValue: edit.label)
        _number = State(initialValue: passport["number"] as? String ?? "")
        _issuingCountry = State(initialValue: passport["issuingCountryCode"] as? String ?? region)
        _nationality = State(initialValue: passport["nationalityCode"] as? String ?? region)
        _issueDate = State(initialValue: AnswerStore.passportDate(passport["issueDate"] as? String))
        _expirationDate = State(initialValue: AnswerStore.passportDate(passport["expirationDate"] as? String))
    }

    private var canSave: Bool {
        !number.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationView {
            Form {
                Section {
                    TextField("Passport", text: $label)
                } header: {
                    Text("Label")
                } footer: {
                    Text("Name a second passport after its country or holder.")
                }
                Section {
                    TextField("Passport number", text: $number)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    countryPicker("Issuing country", selection: $issuingCountry)
                    countryPicker("Nationality", selection: $nationality)
                }
                Section {
                    OptionalDateRow(title: String(localized: "Issue date"), date: $issueDate)
                    OptionalDateRow(title: String(localized: "Expiration date"), date: $expirationDate)
                } footer: {
                    Text("A date of birth is never filled into these.")
                }
                if let problem {
                    Section { Text(problem).foregroundColor(.red) }
                }
            }
            .navigationTitle(answerID == nil ? String(localized: "New Passport") : String(localized: "Edit Passport"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(!canSave || isSaving)
                }
            }
        }
        .navigationViewStyle(.stack)
    }

    private func countryPicker(_ title: LocalizedStringKey, selection: Binding<String>) -> some View {
        Picker(title, selection: selection) {
            Text("None", comment: "No country chosen for a passport").tag("")
            ForEach(regions, id: \.code) { Text($0.name).tag($0.code) }
        }
    }

    private func save() async {
        isSaving = true
        var passport: [String: Any] = ["version": 1, "number": number]
        for (key, code) in [("issuingCountry", issuingCountry), ("nationality", nationality)] where !code.isEmpty {
            passport["\(key)Code"] = code
            passport["\(key)Name"] = regions.first { $0.code == code }?.name ?? code
        }
        if let issueDate { passport["issueDate"] = AnswerStore.passportDateString(issueDate) }
        if let expirationDate { passport["expirationDate"] = AnswerStore.passportDateString(expirationDate) }
        problem = await model.savePassport(answerID: answerID, label: label, passport: passport)
        isSaving = false
        if problem == nil { dismiss() }
    }
}

/// A date that may be left out: a button to add it, then a date picker that
/// can be cleared.
struct OptionalDateRow: View {
    let title: String
    @Binding var date: Date?

    var body: some View {
        if let current = date {
            HStack {
                DatePicker(title, selection: Binding(get: { current }, set: { date = $0 }), displayedComponents: .date)
                    .environment(\.timeZone, TimeZone(identifier: "UTC")!)
                Button {
                    date = nil
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundColor(.secondary)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(Text("Remove \(title)", comment: "Clears a passport date; the placeholder is its name, like Issue date"))
            }
        } else {
            Button {
                date = AnswerStore.passportDate(AnswerStore.passportDateString(Date()))
            } label: {
                Label(title, systemImage: "plus.circle")
            }
        }
    }
}

struct PrivacyTab: View {
    private let points: [(String, String, String)] = [
        ("lock", String(localized: "Answers are encrypted"), String(localized: "Saved answers are encrypted with AES-GCM in Umete’s app storage. The key is kept in Apple Keychain, and in your iCloud Keychain when sync is on.")),
        ("icloud", String(localized: "iCloud sync stays private"), String(localized: "With Sync with iCloud on, each answer is encrypted on this device before it goes to your private iCloud database, so Apple can’t read it. You can turn sync off on the General tab.")),
        ("sparkles", String(localized: "Answer values are never sent to AI"), String(localized: "For fields Umete can’t match itself, it sends only descriptions such as labels, field types, headings, and menu options, plus the labels of your saved answers. Saved values, values in the form, addresses, and contacts’ names stay on your device.")),
        ("eye.slash", String(localized: "Sensitive fields are skipped"), String(localized: "Umete does not save passwords, payment fields, hidden values, or fields identified as security secrets.")),
        ("chart.bar.xaxis", String(localized: "No analytics"), String(localized: "Umete has no account and collects no analytics.")),
    ]

    var body: some View {
        NavigationView {
            List {
                Section {
                    ForEach(points, id: \.1) { icon, title, detail in
                        Label {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(title).font(.headline)
                                Text(detail).font(.subheadline).foregroundColor(.secondary)
                            }
                            .padding(.vertical, 4)
                        } icon: {
                            Image(systemName: icon).foregroundColor(.accentColor)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                Section {
                    Link("Privacy Policy", destination: URL(string: "https://umete.jp/privacy")!)
                }
            }
            .navigationTitle("Privacy")
        }
        .navigationViewStyle(.stack)
    }
}

// MARK: - Onboarding

struct OnboardingView: View {
    @EnvironmentObject private var model: SettingsModel

    var body: some View {
        NavigationView {
            Form {
                Section {
                    VStack(spacing: 12) {
                        AppIconImage(size: 88)
                        Text("Welcome to Umete").font(.title.weight(.bold)).multilineTextAlignment(.center)
                        Text("Umete remembers answers you choose and fills similar web forms in Safari. It matches on your device first and uses AI only when needed.")
                            .multilineTextAlignment(.center)
                            .foregroundColor(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .listRowBackground(Color.clear)
                }
                Section {
                    ProviderFields()
                } header: {
                    Text("AI Matching")
                } footer: {
                    Text("Umete (free) works without a key, with a daily limit. Keys you add are stored in Apple Keychain. Saved answer values are never sent for AI matching.")
                }
                Section {
                    Button {
                        Task { await model.saveSettings(completingOnboarding: true) }
                    } label: {
                        Text("Continue").font(.headline).frame(maxWidth: .infinity)
                    }
                }
            }
            .navigationBarHidden(true)
        }
        .navigationViewStyle(.stack)
        .interactiveDismissDisabled()
    }
}
