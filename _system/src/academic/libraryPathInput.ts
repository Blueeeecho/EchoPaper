export function libraryPathInput(value: string, absolute: boolean, windows: boolean): string {
  const trimmed = value.trim();
  if (!windows) return trimmed;
  const unquoted = trimmed.replace(/^"(.*)"$/, '$1');
  return absolute ? unquoted : unquoted.replace(/\\/g, '/');
}
