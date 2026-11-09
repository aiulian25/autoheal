/** A panel's button: the one showing, or amber while it has something left behind to look at. */
export function chipClassOf(active: boolean, attention: boolean): string {
  if (active) return "chip-button active";
  return attention ? "chip-button network-chip" : "chip-button";
}

export const toggled = (names: ReadonlySet<string>, name: string) =>
  names.has(name) ? new Set([...names].filter((other) => other !== name)) : new Set([...names, name]);
