import Foundation

/// The manage-values screen's rules and wording (2026-09-01), kept out of
/// the view so they can be tested without a screen - the same split the
/// web client's `manageValues.ts` uses, and deliberately the same answers,
/// because the two clients are describing the same act to the same two
/// people.
///
/// What the screen is for: `category`, `payment method` and `vendor` are
/// free text and will stay that way. The lists at
/// `GET /api/receipts/options` are a convenience over what a person has
/// already typed - which means they accumulate every typo, every
/// "Food Basics " with a trailing space, every one-off nobody meant to
/// keep. Renaming rewrites the value on every receipt that carries it;
/// deleting retracts the suggestion and leaves the records alone. That
/// asymmetry is the whole screen, and both halves of it are stated on it.
enum ManageValuesRules {
    /// Whether a typed rename is worth sending, and what it would do.
    enum RenameValidation: Equatable {
        case ready(to: String, merges: Bool)
        case blank
        case unchanged
    }

    /// The typed target is TRIMMED, matching what every other free-text
    /// box in this app does on save - a trailing space picked up while
    /// typing a replacement is a slip, not a value someone meant. That is
    /// not a retreat from the 2026-08-26 "free text is never normalized"
    /// ruling: the value being renamed FROM is passed through untouched
    /// and matched exactly, so a stray-space value that already exists is
    /// still reachable, still distinct, and still renameable - which is
    /// one of the things this screen is for.
    ///
    /// `merges` is true when the target is already one of the person's
    /// values. Allowed on purpose - collapsing "Food basics" into "Food
    /// Basics" is the commonest reason to rename at all - but surfaced,
    /// because it is the one rename that makes a list entry disappear as
    /// well as change.
    static func validateRename(from: String, to: String, existing: [String]) -> RenameValidation {
        let trimmed = to.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            // Deliberately not treated as "delete it": clearing the box is
            // how a rename gets abandoned, and a blank rename that
            // silently deleted the value would be the most destructive
            // possible reading of an empty input.
            return .blank
        }
        if trimmed == from {
            return .unchanged
        }
        return .ready(to: trimmed, merges: existing.contains(trimmed))
    }

    static let blankRenameMessage = "Type the new value, or cancel - an empty name is not a delete."

    /// What a completed rename reports back - the server's own count, in
    /// words, because "12 receipts updated" and "0" are different events.
    static func renameResultMessage(from: String, to: String, receiptsUpdated: Int) -> String {
        let receipts: String
        switch receiptsUpdated {
        case 0: receipts = "No receipts carried it"
        case 1: receipts = "1 receipt updated"
        default: receipts = "\(receiptsUpdated) receipts updated"
        }
        return "Renamed “\(from)” to “\(to)”. \(receipts)."
    }

    /// Asked before a rename that would collapse two list entries into
    /// one. The list is what changes shape here; the receipts are simply
    /// rewritten, which is what a rename always does.
    static func mergeConfirmation(to: String) -> String {
        "“\(to)” is already in this list. The two become one entry, and every receipt carrying the old name says the new one."
    }

    /// The delete confirmation. It states what survives in the same breath
    /// as what goes: this removes a SUGGESTION, and every receipt keeps
    /// the words on it. A confirmation that said only "remove this value?"
    /// would be read by a reasonable person as "erase it from my records",
    /// which is the one thing it does not do.
    static func deleteConfirmation(field: ReceiptOptionField, value: String) -> String {
        "Remove “\(value)” from the \(field.noun) list? Receipts that use it keep the text - only the suggestion goes."
    }

    static func deleteResultMessage(value: String) -> String {
        "Removed “\(value)” from the list. Receipts that used it still say so."
    }
}

/// The two calls the manage-values screen makes, plus the one refresh
/// every change is followed by.
///
/// The refresh is unconditional after a success: a rename can remove a
/// list entry (a merge), add one, and reorder the rest, and none of that
/// is predictable from here - the server owns the ordering
/// (`last_used_at`), and guessing at it locally is how a screen starts
/// disagreeing with the pickers on the confirm form.
@MainActor
final class ManageValuesModel: ObservableObject {
    /// The server's own words for whatever last went wrong, or nil.
    /// Surfaced verbatim (`APIError.requestFailed` already carries the
    /// message unchanged), never reworded.
    @Published private(set) var errorMessage: String?
    /// What the last completed change did, in words. Cleared when the next
    /// one starts.
    @Published private(set) var notice: String?
    /// True while a change is in flight; the screen disables its actions
    /// so a second tap cannot race the first.
    @Published private(set) var isBusy = false

    private let api: any KeptAPI
    private let options: ReceiptOptionsStore

    init(api: any KeptAPI, options: ReceiptOptionsStore) {
        self.api = api
        self.options = options
    }

    func refresh() async {
        await options.refresh()
    }

    func rename(field: ReceiptOptionField, from: String, to: String) async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        errorMessage = nil
        notice = nil
        do {
            let receiptsUpdated = try await api.renameReceiptOption(field: field, from: from, to: to)
            notice = ManageValuesRules.renameResultMessage(
                from: from,
                to: to,
                receiptsUpdated: receiptsUpdated
            )
            await options.refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func delete(field: ReceiptOptionField, value: String) async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        errorMessage = nil
        notice = nil
        do {
            try await api.deleteReceiptOption(field: field, value: value)
            notice = ManageValuesRules.deleteResultMessage(value: value)
            await options.refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func reportBlankRename() {
        notice = nil
        errorMessage = ManageValuesRules.blankRenameMessage
    }

    func clearMessages() {
        notice = nil
        errorMessage = nil
    }
}
