import { config } from "../config";

type FetchOpts = {
  datasetId: string;
  select: string;
  where?: string;
  orderBy?: string;
  offset: number;
  limit: number;
};

export async function fetchSocrataRows(opts: FetchOpts): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams();
  params.set("$select", opts.select);
  params.set("$limit", String(opts.limit));
  params.set("$offset", String(opts.offset));
  if (opts.where) params.set("$where", opts.where);
  if (opts.orderBy) params.set("$order", opts.orderBy);

  const url = `${config.nycBaseUrl}/${opts.datasetId}.json?${params.toString()}`;
  const headers: Record<string, string> = {};
  if (config.nycAppToken) {
    headers["X-App-Token"] = config.nycAppToken;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Socrata fetch failed (${res.status}): ${body.slice(0, 600)}`);
  }

  const parsed = (await res.json()) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Unexpected Socrata response shape");
  }

  return parsed as Record<string, unknown>[];
}
