/** Minimal CSV writer — RFC 4180 quoting, UTF-8, no dependencies. */
export function csvRow(fields: ReadonlyArray<unknown>): string {
  return fields
    .map((f) => {
      const s = f == null ? '' : String(f);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(',');
}

export function toCsv(header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return [csvRow(header), ...rows.map(csvRow)].join('\r\n') + '\r\n';
}
