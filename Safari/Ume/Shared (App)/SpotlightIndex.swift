import CoreSpotlight
import UniformTypeIdentifiers

/// Lets Spotlight find the app by what it does, not only by its name. The index holds
/// this one fixed item, written on each launch, and never any saved answers. Choosing
/// it just opens the app.
enum SpotlightIndex {
    private static let identifier = "com.justin.henry.ume.fill-forms"

    static func update() {
        guard CSSearchableIndex.isIndexingAvailable() else { return }
        let attributes = CSSearchableItemAttributeSet(contentType: .text)
        attributes.title = "Umete: Autofill forms"
        attributes.displayName = "Umete: Autofill forms"
        attributes.contentDescription = "Fill web forms in Safari with answers you’ve saved"
        attributes.keywords = [
            "autofill", "auto fill", "auto-fill", "form", "forms", "form filler", "fill in",
            "自動入力", "フォーム", "フォーム入力", "入力", "埋める"
        ]
        let item = CSSearchableItem(uniqueIdentifier: identifier, domainIdentifier: nil, attributeSet: attributes)
        // Items otherwise expire after a month, which an app opened rarely wouldn't renew.
        item.expirationDate = .distantFuture
        CSSearchableIndex.default().indexSearchableItems([item])
    }
}
