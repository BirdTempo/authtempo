/** One log of a Worker, as a Tail Worker gets it. The Workers Logs sink writes one event per log. */
interface TailItem {
  logs: { message: unknown[] }[];
}

/** The events of level error in the logs of the tailed Worker. */
export function errorEvents(items: readonly TailItem[]): unknown[] {
  return items
    .flatMap((item) => item.logs.map((log) => log.message[0]))
    .filter((m) => typeof m === "object" && m !== null && Reflect.get(m, "level") === "error");
}

export default {
  // Posts each error event to the alert URL of the app, such as a chat webhook.
  async tail(items: TailItem[], env: { ALERT_URL: string }): Promise<void> {
    const errors = errorEvents(items);
    if (errors.length > 0)
      await fetch(env.ALERT_URL, { method: "POST", body: JSON.stringify(errors) });
  },
};
