import SwiftUI

/// Manage values (2026-09-01): the three reusable lists - vendors,
/// categories, payment methods - each value renameable and removable, on
/// the phone as well as on the web.
///
/// The rules and the wording are `ManageValuesModel.swift`'s; this file is
/// the screen over them. Two gestures, and they are deliberately not
/// symmetric, because the acts are not: a tap renames (which rewrites
/// every receipt carrying the value) and a swipe removes (which touches no
/// receipt at all). Both say which they are before they happen.
struct ManageValuesView: View {
    @StateObject private var model: ManageValuesModel
    @ObservedObject private var options: ReceiptOptionsStore

    /// The value being renamed, if any - one at a time, so the screen
    /// never holds two half-finished edits.
    @State private var renaming: ValueRef?
    @State private var renameDraft = ""
    /// A rename that would collapse two list entries into one, waiting for
    /// its own yes: the person asked for a rename and is getting a merge,
    /// which is a different shape of change and is said out loud first.
    @State private var confirmingMerge: PendingRename?
    @State private var confirmingDelete: ValueRef?

    /// One value in one list. `Identifiable` so it can drive a
    /// presentation directly.
    private struct ValueRef: Identifiable, Equatable {
        let field: ReceiptOptionField
        let value: String
        var id: String { "\(field.rawValue)|\(value)" }
    }

    private struct PendingRename: Identifiable, Equatable {
        let field: ReceiptOptionField
        let from: String
        let to: String
        var id: String { "\(field.rawValue)|\(from)|\(to)" }
    }

    init(api: any KeptAPI, options: ReceiptOptionsStore) {
        _model = StateObject(wrappedValue: ManageValuesModel(api: api, options: options))
        self.options = options
    }

    var body: some View {
        List {
            Section {
                Text("The vendors, categories and payment methods offered on the confirm form - your own past values, not a fixed list. Renaming one rewrites it on every receipt that carries it. Removing one takes it off this list only: the receipts keep their text.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if let errorMessage = model.errorMessage {
                Section {
                    // The server's own words, never reworded.
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            if let notice = model.notice {
                Section {
                    Text(notice)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("manageValues.notice")
                }
            }

            ForEach(ReceiptOptionField.allCases) { field in
                section(for: field)
            }
        }
        .navigationTitle("Manage values")
        .navigationBarTitleDisplayMode(.inline)
        .disabled(model.isBusy)
        // The list is the whole screen's content, so it is refreshed on
        // arrival rather than trusted to whatever Home last cached: this
        // is the one screen whose job is the list itself.
        .task {
            await model.refresh()
        }
        .refreshable {
            await model.refresh()
        }
        .alert("Rename value", isPresented: renameIsPresented, presenting: renaming) { target in
            TextField("New value", text: $renameDraft)
                .autocorrectionDisabled()
                .accessibilityIdentifier("manageValues.renameField")
            Button("Rename") {
                submitRename(target)
            }
            Button("Cancel", role: .cancel) {
                renaming = nil
            }
        } message: { target in
            Text("“\(target.value)” is rewritten on every receipt that carries it.")
        }
        // The merge is asked separately rather than inside the rename
        // alert: an alert's message is fixed when it opens, so a warning
        // that only becomes true as someone types cannot honestly live
        // there. This is that warning, at the moment it is actionable.
        .confirmationDialog(
            "Merge into an existing value?",
            isPresented: mergeIsPresented,
            titleVisibility: .visible,
            presenting: confirmingMerge
        ) { pending in
            Button("Merge them") {
                confirmingMerge = nil
                Task { await model.rename(field: pending.field, from: pending.from, to: pending.to) }
            }
            Button("Cancel", role: .cancel) {
                confirmingMerge = nil
            }
        } message: { pending in
            Text(ManageValuesRules.mergeConfirmation(to: pending.to))
        }
        .confirmationDialog(
            "Remove from the list?",
            isPresented: deleteIsPresented,
            titleVisibility: .visible,
            presenting: confirmingDelete
        ) { target in
            Button("Remove from list", role: .destructive) {
                confirmingDelete = nil
                Task { await model.delete(field: target.field, value: target.value) }
            }
            Button("Keep it", role: .cancel) {
                confirmingDelete = nil
            }
        } message: { target in
            Text(ManageValuesRules.deleteConfirmation(field: target.field, value: target.value))
        }
    }

    @ViewBuilder
    private func section(for field: ReceiptOptionField) -> some View {
        let values = field.values(in: options.options)
        Section(field.title) {
            if values.isEmpty {
                Text(field.emptyNote)
                    .font(.footnote)
                    .italic()
                    .foregroundStyle(.secondary)
            } else {
                ForEach(values, id: \.self) { value in
                    Button {
                        renaming = ValueRef(field: field, value: value)
                        renameDraft = value
                        model.clearMessages()
                    } label: {
                        HStack {
                            Text(value)
                            Spacer()
                            Image(systemName: "pencil")
                                .font(.footnote)
                                .foregroundStyle(Color.accentColor)
                        }
                        .contentShape(Rectangle())
                    }
                    // `.plain`, so the VALUE reads as the person's own
                    // text rather than as a link: a Button's label takes
                    // the accent colour otherwise, and a screen of blue
                    // rows says "these are actions" when what it is
                    // showing is data. The pencil carries the affordance.
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("manageValues.\(field.rawValue).\(value)")
                    .swipeActions(edge: .trailing) {
                        // Never `allowsFullSwipe` - the confirmation below
                        // is what states that the receipts keep their
                        // text, and a full swipe that skipped it would be
                        // a person deleting something they had not been
                        // told the shape of.
                        Button(role: .destructive) {
                            confirmingDelete = ValueRef(field: field, value: value)
                            model.clearMessages()
                        } label: {
                            Label("Remove", systemImage: "minus.circle")
                        }
                    }
                }
            }
        }
    }

    private func submitRename(_ target: ValueRef) {
        let existing = target.field.values(in: options.options)
        switch ManageValuesRules.validateRename(from: target.value, to: renameDraft, existing: existing) {
        case .blank:
            renaming = nil
            model.reportBlankRename()
        case .unchanged:
            renaming = nil
        case .ready(let to, let merges):
            renaming = nil
            if merges {
                confirmingMerge = PendingRename(field: target.field, from: target.value, to: to)
            } else {
                Task { await model.rename(field: target.field, from: target.value, to: to) }
            }
        }
    }

    // `presenting:` needs a Bool binding alongside the value; these three
    // are that binding, written out rather than repeated inline.
    private var renameIsPresented: Binding<Bool> {
        Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
    }

    private var mergeIsPresented: Binding<Bool> {
        Binding(get: { confirmingMerge != nil }, set: { if !$0 { confirmingMerge = nil } })
    }

    private var deleteIsPresented: Binding<Bool> {
        Binding(get: { confirmingDelete != nil }, set: { if !$0 { confirmingDelete = nil } })
    }
}
