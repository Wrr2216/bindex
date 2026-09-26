import { registerEventTypes } from "../event-backbone";

// The events this feature publishes; see the catalog in docs/ai-condition.md.
registerEventTypes([
  {
    type: "condition_report.created",
    group: "Condition",
    subject: "condition_report",
    description: "A condition report was recorded for an item or unit.",
  },
  {
    type: "condition_report.updated",
    group: "Condition",
    subject: "condition_report",
    description: "A condition report was corrected. Lists the changed fields with their values before and after.",
  },
  {
    type: "condition_report.deleted",
    group: "Condition",
    subject: "condition_report",
    description: "A condition report was removed.",
  },
  {
    type: "container.captured",
    group: "Condition",
    subject: "item",
    description: "A container's size, markings and contents were recorded, and its contents added as items.",
  },
  {
    type: "condition_sweep.started",
    group: "Condition",
    subject: "condition_sweep",
    description: "A condition sweep of a location began.",
  },
  {
    type: "condition_sweep.closed",
    group: "Condition",
    subject: "condition_sweep",
    description: "A condition sweep was finished, with how many items were checked.",
  },
]);
