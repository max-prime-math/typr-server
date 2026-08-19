export type ActivityLevel = "info" | "warning" | "error";

export interface ActivityEvent {
  id: number;
  timestamp: string;
  serviceId: string;
  level: ActivityLevel;
  type: string;
  message: string;
  userId?: string;
  requestId?: string;
  durationMs?: number;
  details?: string;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export type ActivityInput = Omit<ActivityEvent, "id" | "timestamp"> & {
  timestamp?: string;
};

const MAX_MESSAGE_LENGTH = 2_000;
const MAX_DETAILS_LENGTH = 128 * 1024;

/** Bounded, process-local activity history with live subscribers for the management UI. */
export class ActivityBus {
  private readonly events: ActivityEvent[] = [];
  private readonly listeners = new Set<(event: ActivityEvent) => void>();
  private readonly maxEvents: number;
  private nextId = 1;

  constructor(maxEvents = 1_000) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) {
      throw new Error("Activity history size must be a positive integer.");
    }
    this.maxEvents = maxEvents;
  }

  publish(input: ActivityInput): ActivityEvent {
    const event: ActivityEvent = {
      ...input,
      id: this.nextId,
      timestamp: input.timestamp ?? new Date().toISOString(),
      message: truncate(input.message, MAX_MESSAGE_LENGTH),
      ...(input.details ? { details: truncate(input.details, MAX_DETAILS_LENGTH) } : {})
    };
    this.nextId += 1;
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  snapshot(options: { serviceId?: string; afterId?: number; limit?: number } = {}): ActivityEvent[] {
    const limit = Math.max(1, Math.min(options.limit ?? this.maxEvents, this.maxEvents));
    return this.events
      .filter((event) => (!options.serviceId || event.serviceId === options.serviceId) &&
        (!options.afterId || event.id > options.afterId))
      .slice(-limit);
  }

  subscribe(listener: (event: ActivityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n[truncated by management activity log]`;
}
