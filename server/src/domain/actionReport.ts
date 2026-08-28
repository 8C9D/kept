import {
  EVENT_ACTIONS,
  EVENT_FIELDS,
  type EventAction,
  type EventField,
} from "./userEvents.js";

/**
 * The aggregation behind `npm run action-report` (db/actionReport.ts),
 * split out the way parseAccuracy.ts is: the counting logic is pure and
 * unit-testable, and the script that owns the database connection just
 * reads rows and prints what this computes.
 *
 * Two different signals live in the same field, and the report keeps them
 * apart rather than collapsing them into one number:
 *
 *   - `field_edited` is about EDITING BEHAVIOUR: a field a person typed
 *     into, whether or not it ever carried a suggestion (`notes` has no
 *     suggestion to accept or override, but people still edit it).
 *     `editedTotal` sums each event's `count` (a field edited four times
 *     before save logs one event with count 4, not four events) - that is
 *     the number the owner actually asked for.
 *   - `suggestionAccepted` / `suggestionOverridden` are about PARSE
 *     QUALITY: did the person keep what the parser suggested, or replace
 *     it. A field with a high override rate is a field whose extraction is
 *     unreliable in exactly the sense the brief names.
 *
 * Neither substitutes for the other: a field can be edited often without a
 * suggestion existing (typing a category from scratch), and a suggestion
 * can be overridden in a single decisive edit that never fires
 * `field_edited` at all, depending on how a client instruments its form.
 */

export interface RawEvent {
  action: EventAction;
  field: EventField | null;
  /** Present only on `field_edited`; null/absent counts as one edit. */
  count: number | null;
}

export interface ActionTally {
  action: EventAction;
  count: number;
}

export interface FieldActivity {
  field: EventField;
  /** Number of `field_edited` events logged for this field. */
  editedEvents: number;
  /** Sum of those events' `count` (absent count treated as 1). */
  editedTotal: number;
  suggestionAccepted: number;
  suggestionOverridden: number;
}

export interface ActionReportResult {
  eventCount: number;
  /** Every action in the vocabulary, zero included, most frequent first. */
  actionTallies: ActionTally[];
  /** Every field in the vocabulary, most-edited first. */
  fieldActivity: FieldActivity[];
}

export function aggregateActionReport(events: RawEvent[]): ActionReportResult {
  const actionCounts = new Map<EventAction, number>(
    EVENT_ACTIONS.map((action) => [action, 0]),
  );
  const fieldActivity = new Map<EventField, FieldActivity>(
    EVENT_FIELDS.map((field) => [
      field,
      {
        field,
        editedEvents: 0,
        editedTotal: 0,
        suggestionAccepted: 0,
        suggestionOverridden: 0,
      },
    ]),
  );

  for (const event of events) {
    actionCounts.set(event.action, (actionCounts.get(event.action) ?? 0) + 1);

    if (event.field === null) {
      continue;
    }
    const activity = fieldActivity.get(event.field);
    if (activity === undefined) {
      // The field vocabulary is closed (EVENT_FIELDS) and the caller reads
      // rows this same process wrote through the validated route; reaching
      // this means the two have drifted apart.
      throw new Error(`No field activity bucket initialized for "${event.field}"`);
    }

    if (event.action === "field_edited") {
      activity.editedEvents += 1;
      activity.editedTotal += event.count ?? 1;
    } else if (event.action === "suggestion_accepted") {
      activity.suggestionAccepted += 1;
    } else if (event.action === "suggestion_overridden") {
      activity.suggestionOverridden += 1;
    }
  }

  const actionTallies = [...actionCounts.entries()]
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action));

  const fieldActivityList = [...fieldActivity.values()].sort(
    (a, b) => b.editedTotal - a.editedTotal || a.field.localeCompare(b.field),
  );

  return {
    eventCount: events.length,
    actionTallies,
    fieldActivity: fieldActivityList,
  };
}
