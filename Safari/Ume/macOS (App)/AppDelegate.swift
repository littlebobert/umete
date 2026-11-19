import Cocoa
import Sparkle

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    private var settingsWindowController: NSWindowController?
    private var onboardingWindowController: OnboardingWindowController?
    private var aboutWindowController: AboutWindowController?
    private var privacyWindowController: PrivacyWindowController?
    private let updaterController = SPUStandardUpdaterController(
        startingUpdater: true,
        updaterDelegate: nil,
        userDriverDelegate: nil
    )

    private var syncTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        installEditMenu()
        installWindowMenu()
        installSettingsShortcut()
        installUpdateMenu()
        installAboutAction()
        configureSettingsWindow()
        startCloudSync()
        SpotlightIndex.update()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        CloudSync.shared.syncInBackground(reason: .activate)
    }

    private func startCloudSync() {
        CloudSync.shared.syncInBackground(reason: .launch)
        NotificationCenter.default.addObserver(forName: AnswerStore.didChangeLocally, object: nil, queue: .main) { _ in
            CloudSync.shared.syncInBackground(reason: .localChange)
        }
        syncTimer = Timer.scheduledTimer(withTimeInterval: 90, repeats: true) { _ in
            guard NSApp.isActive || NSApp.windows.contains(where: { $0.isVisible }) else { return }
            CloudSync.shared.syncInBackground(reason: .timer)
        }
    }

    private func configureSettingsWindow() {
        guard let window = NSApp.windows.first else { return }
        window.styleMask.insert([.closable, .miniaturizable, .resizable])
        settingsWindowController = window.windowController
        showSettingsContent(in: window)
        window.center()
        if !OnboardingStore.isComplete {
            window.orderOut(nil)
            showOnboarding(nil)
        }
    }

    private func showSettingsContent(in window: NSWindow) {
        window.title = String(localized: "Umete Settings")
        window.contentViewController = SettingsTabViewController()
        window.contentMinSize = NSSize(width: 720, height: 500)
        window.setContentSize(NSSize(width: 760, height: 620))
        window.center()
    }

    private func installEditMenu() {
        guard let mainMenu = NSApp.mainMenu,
              !mainMenu.items.contains(where: { $0.submenu?.items.contains { $0.action == #selector(NSText.cut(_:)) } == true }) else { return }
        let item = NSMenuItem(title: String(localized: "Edit", comment: "Edit menu"), action: nil, keyEquivalent: "")
        let menu = NSMenu(title: String(localized: "Edit", comment: "Edit menu"))
        item.submenu = menu
        menu.addItem(withTitle: String(localized: "Undo"), action: Selector(("undo:")), keyEquivalent: "z")
        menu.addItem(withTitle: String(localized: "Redo"), action: Selector(("redo:")), keyEquivalent: "Z")
        menu.addItem(.separator())
        menu.addItem(withTitle: String(localized: "Cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        menu.addItem(withTitle: String(localized: "Copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        menu.addItem(withTitle: String(localized: "Paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        menu.addItem(withTitle: String(localized: "Select All"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        mainMenu.insertItem(item, at: min(1, mainMenu.items.count))
    }

    private func installWindowMenu() {
        guard let mainMenu = NSApp.mainMenu,
              NSApp.windowsMenu == nil else { return }
        let item = NSMenuItem(title: String(localized: "Window", comment: "Window menu"), action: nil, keyEquivalent: "")
        let menu = NSMenu(title: String(localized: "Window", comment: "Window menu"))
        item.submenu = menu
        menu.addItem(withTitle: String(localized: "Minimize"), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        menu.addItem(withTitle: String(localized: "Zoom", comment: "Window menu command that zooms (maximizes) the window"), action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: String(localized: "Close Window"), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        NSApp.windowsMenu = menu
        // Menus are found by what they do, not their titles, which differ by language.
        let helpIndex = mainMenu.items.firstIndex(where: { $0.submenu?.items.contains { $0.action == #selector(NSApplication.showHelp(_:)) } == true }) ?? mainMenu.items.count
        mainMenu.insertItem(item, at: helpIndex)
    }

    private func installSettingsShortcut() {
        guard let appMenu = NSApp.mainMenu?.items.first?.submenu else { return }
        let item = NSMenuItem(title: String(localized: "Settings…"), action: #selector(showSettings(_:)), keyEquivalent: ",")
        item.target = self
        appMenu.insertItem(item, at: min(2, appMenu.items.count))
        appMenu.insertItem(.separator(), at: min(3, appMenu.items.count))
    }

    private func installUpdateMenu() {
        guard let appMenu = NSApp.mainMenu?.items.first?.submenu,
              !appMenu.items.contains(where: { $0.action == #selector(checkForUpdates(_:)) }) else { return }
        let item = NSMenuItem(title: String(localized: "Check for Updates…"), action: #selector(checkForUpdates(_:)), keyEquivalent: "")
        item.target = self
        let settingsIndex = appMenu.items.firstIndex(where: { $0.action == #selector(showSettings(_:)) }) ?? 1
        let insertionIndex = min(settingsIndex + 2, appMenu.items.count)
        appMenu.insertItem(item, at: insertionIndex)
        appMenu.insertItem(.separator(), at: min(insertionIndex + 1, appMenu.items.count))
    }

    @objc private func checkForUpdates(_ sender: Any?) {
        updaterController.checkForUpdates(sender)
    }

    private func installAboutAction() {
        guard let about = NSApp.mainMenu?.items.first?.submenu?.items.first(where: { $0.action == #selector(NSApplication.orderFrontStandardAboutPanel(_:)) }) else { return }
        about.target = self
        about.action = #selector(showAbout(_:))
    }

    @objc private func showSettings(_ sender: Any?) {
        settingsWindowController?.showWindow(sender)
        settingsWindowController?.window?.makeKeyAndOrderFront(sender)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func showOnboarding(_ sender: Any?) {
        if onboardingWindowController == nil {
            onboardingWindowController = OnboardingWindowController { [weak self] in
                self?.onboardingWindowController?.close()
                NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: "/Applications/Safari.app"), configuration: NSWorkspace.OpenConfiguration())
            }
        }
        onboardingWindowController?.showWindow(sender)
        onboardingWindowController?.window?.makeKeyAndOrderFront(sender)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func showAbout(_ sender: Any?) {
        if aboutWindowController == nil {
            aboutWindowController = AboutWindowController { [weak self] in self?.showPrivacy() }
        }
        aboutWindowController?.showWindow(sender)
        aboutWindowController?.window?.makeKeyAndOrderFront(sender)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func showPrivacy() {
        if privacyWindowController == nil { privacyWindowController = PrivacyWindowController() }
        privacyWindowController?.showWindow(nil)
        privacyWindowController?.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first(where: { $0.scheme == "ume" }) else { return }
        if url.host == "onboarding" {
            showOnboarding(nil)
        } else {
            showSettings(nil)
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showSettings(nil) }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}
