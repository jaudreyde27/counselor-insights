import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Id the model uses when nothing in the taxonomy fits. Reserved: config may not define it. */
export const OTHER_SUB_DRIVER_ID = "other";

// `looseObject` keeps extra fields instead of rejecting or stripping them, so
// the taxonomy can grow new properties without a code change.
const domainSchema = z.looseObject({
  id: z.string().min(1),
  label: z.string().min(1),
  tagline: z.string().optional(),
});

const subDriverSchema = z.looseObject({
  id: z.string().min(1),
  domain_id: z.string().min(1),
  group: z.string().nullable().optional(),
  label: z.string().min(1),
  description: z.string().nullable().optional(),
});

const criteriaSchema = z.looseObject({
  version: z.string().min(1),
  domains: z.array(domainSchema).min(1),
  sub_drivers: z.array(subDriverSchema).min(1),
  classification_rules: z.array(z.string().min(1)),
});

export type Domain = z.infer<typeof domainSchema>;
export type SubDriver = z.infer<typeof subDriverSchema>;
export type Criteria = z.infer<typeof criteriaSchema> & {
  /** Look up a sub-driver by id. */
  subDriver(id: string): SubDriver | undefined;
  /** Look up a domain by id. */
  domain(id: string): Domain | undefined;
};

/** Validates raw config (already parsed from JSON) and returns it with lookup helpers. */
export function parseCriteria(raw: unknown): Criteria {
  const data = criteriaSchema.parse(raw);

  const domainIds = new Set<string>();
  for (const d of data.domains) {
    if (domainIds.has(d.id)) throw new Error(`Criteria config: duplicate domain id "${d.id}"`);
    domainIds.add(d.id);
  }

  const subIds = new Set<string>();
  for (const s of data.sub_drivers) {
    if (s.id === OTHER_SUB_DRIVER_ID) {
      throw new Error(`Criteria config: "${OTHER_SUB_DRIVER_ID}" is reserved and cannot be a sub-driver id`);
    }
    if (subIds.has(s.id)) throw new Error(`Criteria config: duplicate sub-driver id "${s.id}"`);
    subIds.add(s.id);
    if (!domainIds.has(s.domain_id)) {
      throw new Error(`Criteria config: sub-driver "${s.id}" refers to unknown domain "${s.domain_id}"`);
    }
  }

  const subById = new Map(data.sub_drivers.map((s) => [s.id, s]));
  const domainById = new Map(data.domains.map((d) => [d.id, d]));
  return { ...data, subDriver: (id) => subById.get(id), domain: (id) => domainById.get(id) };
}

let loaded: Criteria | undefined;

/** The app's criteria, loaded once at first use (edit config/criteria.json, then restart). */
export function getCriteria(): Criteria {
  loaded ??= loadCriteria();
  return loaded;
}

/** Reads and validates a criteria file. Defaults to `config/criteria.json`. */
export function loadCriteria(file = path.resolve(process.cwd(), "config", "criteria.json")): Criteria {
  return parseCriteria(JSON.parse(readFileSync(/* turbopackIgnore: true */ file, "utf8")));
}
