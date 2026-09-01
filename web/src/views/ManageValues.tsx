import { useState } from "react";
import type { KeptApi } from "../api.js";
import {
  OPTION_LISTS,
  deleteConfirmText,
  deleteResultMessage,
  optionFieldNoun,
  renameResultMessage,
  validateRename,
  type OptionListSpec,
} from "../manageValues.js";
import type { ReceiptOptionsHandle } from "../options.js";
import type { OptionField } from "../types.js";

/**
 * Manage values (2026-09-01): the three reusable lists, each value
 * renameable and removable.
 *
 * The rules and the wording live in `manageValues.ts`, which has no DOM in
 * it and is where the tests are; this file is the markup over them plus the
 * two API calls. Density over friendliness (§7A), the same as every other
 * screen here - three plain lists, an inline editor, no modals.
 *
 * The asymmetry between the two actions is the whole point of the screen
 * and is stated on it: a rename rewrites every receipt carrying the value,
 * and a delete touches no receipt at all.
 */
export function ManageValuesView({
  api,
  options,
}: {
  api: KeptApi;
  options: ReceiptOptionsHandle;
}) {
  // Which value is being renamed, if any - one at a time, so the screen
  // never has two half-finished edits whose Enter key does different things.
  const [editing, setEditing] = useState<{
    field: OptionField;
    from: string;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<{
    field: OptionField;
    value: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function startRename(field: OptionField, from: string) {
    setEditing({ field, from });
    setDraft(from);
    setConfirming(null);
    setNotice(null);
    setError(null);
  }

  async function rename(existing: readonly string[]) {
    if (editing === null || busy) {
      return;
    }
    const check = validateRename(editing.from, draft, existing);
    if (check.state === "blank") {
      setError("Type the new value, or cancel - an empty name is not a delete.");
      return;
    }
    if (check.state === "unchanged") {
      setEditing(null);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { receiptsUpdated } = await api.renameReceiptOption(
        editing.field,
        editing.from,
        check.to,
      );
      setNotice(renameResultMessage(editing.from, check.to, receiptsUpdated));
      setEditing(null);
      // Unconditional: a rename can remove a list entry (a merge), add one,
      // and reorder the rest, and none of that is predictable from here.
      options.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove(field: OptionField, value: string) {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.deleteReceiptOption(field, value);
      setNotice(deleteResultMessage(value));
      setConfirming(null);
      options.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="manage-values">
      <h2>Manage values</h2>
      <p className="muted">
        The vendors, categories and payment methods offered under those
        fields - your own past values, not a fixed list. Renaming one
        rewrites it on every receipt that carries it. Removing one takes it
        off this list only: the receipts keep their text.
      </p>
      {error !== null && <p className="error">{error}</p>}
      {notice !== null && <p className="muted value-notice">{notice}</p>}
      {OPTION_LISTS.map((list) => (
        <ValueList
          key={list.field}
          list={list}
          values={options.values[list.key]}
          busy={busy}
          editing={editing}
          draft={draft}
          confirming={confirming}
          onDraft={setDraft}
          onStartRename={startRename}
          onCancelRename={() => setEditing(null)}
          onRename={(existing) => void rename(existing)}
          onAskDelete={(field, value) => {
            setConfirming({ field, value });
            setEditing(null);
            setNotice(null);
            setError(null);
          }}
          onCancelDelete={() => setConfirming(null)}
          onDelete={(field, value) => void remove(field, value)}
        />
      ))}
    </section>
  );
}

function ValueList({
  list,
  values,
  busy,
  editing,
  draft,
  confirming,
  onDraft,
  onStartRename,
  onCancelRename,
  onRename,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  list: OptionListSpec;
  values: readonly string[];
  busy: boolean;
  editing: { field: OptionField; from: string } | null;
  draft: string;
  confirming: { field: OptionField; value: string } | null;
  onDraft: (value: string) => void;
  onStartRename: (field: OptionField, from: string) => void;
  onCancelRename: () => void;
  onRename: (existing: readonly string[]) => void;
  onAskDelete: (field: OptionField, value: string) => void;
  onCancelDelete: () => void;
  onDelete: (field: OptionField, value: string) => void;
}) {
  return (
    <div className="value-list">
      <h3>{list.title}</h3>
      {values.length === 0 ? (
        <p className="muted">{list.empty}</p>
      ) : (
        <ul>
          {values.map((value) => {
            const isEditing =
              editing !== null &&
              editing.field === list.field &&
              editing.from === value;
            const isConfirming =
              confirming !== null &&
              confirming.field === list.field &&
              confirming.value === value;
            return (
              <li key={value}>
                {isEditing ? (
                  <RenameEditor
                    field={list.field}
                    from={value}
                    draft={draft}
                    values={values}
                    busy={busy}
                    onDraft={onDraft}
                    onCancel={onCancelRename}
                    onSubmit={() => onRename(values)}
                  />
                ) : (
                  <>
                    <span className="value-name">{value}</span>
                    <button
                      className="link"
                      disabled={busy}
                      onClick={() => onStartRename(list.field, value)}
                    >
                      Rename…
                    </button>
                    {isConfirming ? (
                      <span className="delete-confirm">
                        {deleteConfirmText(list.field, value)}
                        <button
                          className="danger"
                          disabled={busy}
                          onClick={() => onDelete(list.field, value)}
                        >
                          Remove from list
                        </button>
                        <button disabled={busy} onClick={onCancelDelete}>
                          Keep it
                        </button>
                      </span>
                    ) : (
                      <button
                        className="link"
                        disabled={busy}
                        onClick={() => onAskDelete(list.field, value)}
                      >
                        Remove…
                      </button>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The inline rename: a text box, the two obvious keys (Enter submits,
 * Escape cancels), and the merge warning where the person can see it
 * BEFORE pressing the button - two values becoming one is the one outcome
 * of a rename that cannot be undone by renaming back.
 */
function RenameEditor({
  field,
  from,
  draft,
  values,
  busy,
  onDraft,
  onCancel,
  onSubmit,
}: {
  field: OptionField;
  from: string;
  draft: string;
  values: readonly string[];
  busy: boolean;
  onDraft: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const check = validateRename(from, draft, values);
  return (
    <span className="rename-editor">
      <label>
        New {optionFieldNoun(field)}
        <input
          value={draft}
          autoFocus
          disabled={busy}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onSubmit();
            } else if (event.key === "Escape") {
              onCancel();
            }
          }}
        />
      </label>
      <button className="primary" disabled={busy} onClick={onSubmit}>
        Rename
      </button>
      <button disabled={busy} onClick={onCancel}>
        Cancel
      </button>
      {check.state === "ready" && check.merges && (
        <span className="warning">
          “{check.to}” already exists - the two become one value, and every
          receipt saying “{from}” will say “{check.to}”.
        </span>
      )}
    </span>
  );
}
