import SwiftUI

/// Offering a person their own past values back when there are a lot of
/// them (2026-09-01).
///
/// The options route's 100-value cap went away the same day the values got
/// their own table - a person's vocabulary is bounded by how many distinct
/// things they have ever typed, not by their receipt count, and the cap
/// was silently truncating a list the exact-match filter is supposed to be
/// able to reach. What it also did, incidentally, was keep the confirm
/// form's `Menu` short. Uncapped, that menu is a scroll through several
/// hundred vendors with no way to type at it, which on the screen where
/// someone is confirming a receipt in under a minute is worse than no
/// menu at all.
///
/// So: a short list stays a menu (one tap, nothing to dismiss), and a long
/// one becomes a sheet with a search field. The threshold is a rule, not a
/// feeling - twelve is about what fits on screen without scrolling, and a
/// list you can see all of is one a menu serves better than a search box.
enum PastValuesPresentation {
    /// At or below this many values, the plain `Menu`; above it, the
    /// searchable sheet.
    static let menuLimit = 12

    static func usesSearchSheet(valueCount: Int) -> Bool {
        valueCount > menuLimit
    }

    /// The sheet's filter: case- and diacritic-insensitive substring
    /// matching, in the order the server served the values (most recently
    /// used first), because that order is itself the best guess at what
    /// someone is looking for.
    ///
    /// Substring rather than prefix: "basics" should find "Food Basics".
    /// A blank query - including one that is only spaces - matches
    /// everything, which is what an untouched search field means.
    static func filter(_ values: [String], query: String) -> [String] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return values }
        return values.filter {
            $0.range(of: trimmed, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
    }
}

/// The long-list picker: the person's own values, searchable, most recent
/// first. Picking one fills the field, which stays editable - these are
/// suggestions from someone's own data, never a vocabulary to choose from
/// (the 2026-08-26 free-text ruling), and nothing here can introduce a
/// value the person has not used before.
struct PastValuesPickerSheet: View {
    let title: String
    let values: [String]
    let onPick: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var matches: [String] {
        PastValuesPresentation.filter(values, query: query)
    }

    var body: some View {
        NavigationStack {
            List {
                if matches.isEmpty {
                    // A stated absence, not an empty list that reads as a
                    // broken screen. The remedy is on the form behind
                    // this sheet: the field is free text.
                    Text("No match. Close this and type the value.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(matches, id: \.self) { value in
                        Button {
                            onPick(value)
                            dismiss()
                        } label: {
                            Text(value)
                                .foregroundStyle(.primary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
            .searchable(text: $query, prompt: "Search \(title.lowercased())")
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}
