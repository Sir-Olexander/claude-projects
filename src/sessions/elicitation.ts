import type { ElicitationField } from '../shared/protocol';

/**
 * MCP elicitation forms use a restricted JSON schema: a flat object whose
 * properties are strings (optionally with a format), numbers/integers,
 * booleans, single-choice enums (`enum` + `enumNames`, or `oneOf` with
 * `const`/`title`) and multi-choice arrays of such enums.
 */
export function fieldsFromSchema(schema: unknown, order?: string[]): ElicitationField[] {
  if (!schema || typeof schema !== 'object') return [];
  const s = schema as { properties?: Record<string, unknown>; required?: unknown };
  const props = s.properties && typeof s.properties === 'object' ? s.properties : {};
  const required = new Set(Array.isArray(s.required) ? (s.required as unknown[]).filter((x): x is string => typeof x === 'string') : []);
  const names = Object.keys(props);
  if (order?.length) names.sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9));
  const out: ElicitationField[] = [];
  for (const name of names) {
    const p = props[name] as Record<string, unknown>;
    if (!p || typeof p !== 'object') continue;
    const label = typeof p.title === 'string' && p.title ? p.title : humanize(name);
    const description = typeof p.description === 'string' ? p.description : undefined;
    const base = { name, label, description, required: required.has(name) };
    const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : undefined);
    const single = enumOptions(p);
    if (p.type === 'array') {
      const items = (p.items ?? {}) as Record<string, unknown>;
      out.push({
        ...base,
        type: 'multi',
        options: enumOptions(items) ?? [],
        default: Array.isArray(p.default) ? (p.default as unknown[]).map(String) : undefined,
        minItems: num('minItems'),
        maxItems: num('maxItems'),
      });
    } else if (single) {
      out.push({ ...base, type: 'enum', options: single, default: typeof p.default === 'string' ? p.default : undefined });
    } else if (p.type === 'boolean') {
      out.push({ ...base, type: 'boolean', default: typeof p.default === 'boolean' ? p.default : undefined });
    } else if (p.type === 'number' || p.type === 'integer') {
      out.push({ ...base, type: p.type, default: typeof p.default === 'number' ? p.default : undefined, minimum: num('minimum'), maximum: num('maximum') });
    } else {
      out.push({
        ...base,
        type: 'string',
        default: typeof p.default === 'string' ? p.default : undefined,
        format: typeof p.format === 'string' ? p.format : undefined,
        minLength: num('minLength'),
        maxLength: num('maxLength'),
      });
    }
  }
  return out;
}

function enumOptions(p: Record<string, unknown>): { value: string; label: string }[] | undefined {
  if (Array.isArray(p.enum)) {
    const names = Array.isArray(p.enumNames) ? (p.enumNames as unknown[]) : [];
    return (p.enum as unknown[]).map((v, i) => ({ value: String(v), label: typeof names[i] === 'string' ? (names[i] as string) : String(v) }));
  }
  const variants = Array.isArray(p.oneOf) ? p.oneOf : Array.isArray(p.anyOf) ? p.anyOf : undefined;
  if (variants && (variants as unknown[]).every((v) => v && typeof v === 'object' && 'const' in (v as object))) {
    return (variants as Array<{ const: unknown; title?: unknown }>).map((v) => ({ value: String(v.const), label: typeof v.title === 'string' ? v.title : String(v.const) }));
  }
  return undefined;
}

function humanize(name: string): string {
  const s = name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export type ElicitationValue = string | number | boolean | string[];

/** Checks answers against the fields; returns an error message per invalid field. */
export function validateElicitation(fields: ElicitationField[], content: Record<string, ElicitationValue | undefined>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = content[f.name];
    const empty = v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (f.required && f.type !== 'boolean') errors[f.name] = 'Required';
      continue;
    }
    switch (f.type) {
      case 'string': {
        const sv = String(v);
        if (f.minLength !== undefined && sv.length < f.minLength) errors[f.name] = `At least ${f.minLength} characters`;
        else if (f.maxLength !== undefined && sv.length > f.maxLength) errors[f.name] = `At most ${f.maxLength} characters`;
        else if (f.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sv)) errors[f.name] = 'Enter an email address';
        else if (f.format === 'uri' && !/^[a-z][a-z0-9+.-]*:\S+$/i.test(sv)) errors[f.name] = 'Enter a URL';
        else if (f.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(sv)) errors[f.name] = 'Use YYYY-MM-DD';
        break;
      }
      case 'number':
      case 'integer': {
        const n = typeof v === 'number' ? v : Number(v);
        if (Number.isNaN(n)) errors[f.name] = 'Enter a number';
        else if (f.type === 'integer' && !Number.isInteger(n)) errors[f.name] = 'Enter a whole number';
        else if (f.minimum !== undefined && n < f.minimum) errors[f.name] = `At least ${f.minimum}`;
        else if (f.maximum !== undefined && n > f.maximum) errors[f.name] = `At most ${f.maximum}`;
        break;
      }
      case 'enum':
        if (f.options && !f.options.some((o) => o.value === v)) errors[f.name] = 'Pick one of the options';
        break;
      case 'multi': {
        const arr = Array.isArray(v) ? v : [String(v)];
        if (f.minItems !== undefined && arr.length < f.minItems) errors[f.name] = `Pick at least ${f.minItems}`;
        else if (f.maxItems !== undefined && arr.length > f.maxItems) errors[f.name] = `Pick at most ${f.maxItems}`;
        break;
      }
      default:
        break;
    }
  }
  return errors;
}

/** Converts form values to the types the schema asks for (numbers stay numbers, empty values are dropped). */
export function normalizeElicitation(fields: ElicitationField[], content: Record<string, ElicitationValue | undefined>): Record<string, ElicitationValue> {
  const out: Record<string, ElicitationValue> = {};
  for (const f of fields) {
    const v = content[f.name];
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0 && !f.required)) {
      if (f.type === 'boolean') out[f.name] = false;
      continue;
    }
    if (f.type === 'number' || f.type === 'integer') out[f.name] = typeof v === 'number' ? v : Number(v);
    else if (f.type === 'boolean') out[f.name] = v === true || v === 'true';
    else if (f.type === 'multi') out[f.name] = Array.isArray(v) ? v : [String(v)];
    else out[f.name] = String(v);
  }
  return out;
}
