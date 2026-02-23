export type BlockfaceInput = {
  borough?: string | null;
  onStreet?: string | null;
  fromStreet?: string | null;
  toStreet?: string | null;
  sideOfStreet?: string | null;
};

function normalize(value: string | null | undefined): string {
  return (value ?? "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function buildBlockfaceKey(input: BlockfaceInput): string {
  const borough = normalize(input.borough);
  const onStreet = normalize(input.onStreet);
  const fromStreet = normalize(input.fromStreet);
  const toStreet = normalize(input.toStreet);
  const sideOfStreet = normalize(input.sideOfStreet);
  return [borough, onStreet, fromStreet, toStreet, sideOfStreet].join("|");
}

export function isBlockfaceKeyUsable(key: string): boolean {
  if (!key) return false;
  const parts = key.split("|");
  return parts.length === 5 && parts[1] !== "";
}
