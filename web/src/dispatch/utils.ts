export function contains(values: string[] | undefined, needle: string): boolean {
  return values?.includes(needle) ?? false;
}

export function finite(value: number): boolean {
  return Number.isFinite(value);
}
