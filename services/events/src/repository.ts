import type { Queryable } from '@ticketflow/common'
import type { EventDto, EventStatus, EventSummary, SectionInput } from './schemas'

interface EventRow {
  id: string
  organizerId: string
  title: string
  description: string
  venueName: string
  city: string
  startsAt: Date
  currency: 'ARS' | 'USD'
  status: EventStatus
  version: number
  publishedAt: Date | null
  cancelledAt: Date | null
  createdAt: Date
  updatedAt: Date
}

interface SectionRow {
  id: string
  eventId: string
  name: string
  priceCents: number
  rows: number
  seatsPerRow: number
}

const EVENT_COLUMNS = `
  id, organizer_id AS "organizerId", title, description, venue_name AS "venueName", city,
  starts_at AS "startsAt", currency, status, version, published_at AS "publishedAt",
  cancelled_at AS "cancelledAt", created_at AS "createdAt", updated_at AS "updatedAt"`

const SECTION_COLUMNS = `
  id, event_id AS "eventId", name, price_cents AS "priceCents", rows, seats_per_row AS "seatsPerRow"`

const iso = (d: Date | null) => (d ? d.toISOString() : null)

function toDto(row: EventRow, sections: SectionRow[]): EventDto {
  const mapped = sections.map((s) => ({
    id: s.id,
    name: s.name,
    priceCents: s.priceCents,
    rows: s.rows,
    seatsPerRow: s.seatsPerRow,
    capacity: s.rows * s.seatsPerRow,
  }))
  return {
    id: row.id,
    organizerId: row.organizerId,
    title: row.title,
    description: row.description,
    venueName: row.venueName,
    city: row.city,
    startsAt: row.startsAt.toISOString(),
    currency: row.currency,
    status: row.status,
    version: row.version,
    capacity: mapped.reduce((sum, s) => sum + s.capacity, 0),
    sections: mapped,
    publishedAt: iso(row.publishedAt),
    cancelledAt: iso(row.cancelledAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Carga los sectores de varios eventos en una sola query (evita el problema N+1). */
async function withSections(db: Queryable, rows: EventRow[]): Promise<EventDto[]> {
  if (rows.length === 0) return []
  const { rows: sections } = await db.query<SectionRow>(
    `SELECT ${SECTION_COLUMNS} FROM sections WHERE event_id = ANY($1) ORDER BY position`,
    [rows.map((r) => r.id)],
  )
  return rows.map((r) =>
    toDto(
      r,
      sections.filter((s) => s.eventId === r.id),
    ),
  )
}

async function insertSections(db: Queryable, eventId: string, sections: SectionInput[]) {
  // Un único INSERT multi-fila con arrays paralelos en vez de una query por sector.
  await db.query(
    `INSERT INTO sections (event_id, name, price_cents, rows, seats_per_row, position)
     SELECT $1::uuid, * FROM unnest($2::text[], $3::int[], $4::int[], $5::int[], $6::int[])`,
    [
      eventId,
      sections.map((s) => s.name),
      sections.map((s) => s.priceCents),
      sections.map((s) => s.rows),
      sections.map((s) => s.seatsPerRow),
      sections.map((_, i) => i),
    ],
  )
}

export interface NewEvent {
  organizerId: string
  title: string
  description: string
  venueName: string
  city: string
  startsAt: Date
  currency: 'ARS' | 'USD'
  sections: SectionInput[]
}

export type EventPatch = Partial<Omit<NewEvent, 'organizerId' | 'sections'>>

const PATCH_COLUMNS: Record<keyof EventPatch, string> = {
  title: 'title',
  description: 'description',
  venueName: 'venue_name',
  city: 'city',
  startsAt: 'starts_at',
  currency: 'currency',
}

export interface ListFilters {
  from: Date
  to?: Date
  city?: string
  q?: string
  after?: { startsAt: Date; id: string }
  limit: number
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&')

export const eventRepository = {
  async insert(db: Queryable, data: NewEvent): Promise<EventDto> {
    const { rows } = await db.query<EventRow>(
      `INSERT INTO events (organizer_id, title, description, venue_name, city, starts_at, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${EVENT_COLUMNS}`,
      [data.organizerId, data.title, data.description, data.venueName, data.city, data.startsAt, data.currency],
    )
    const event = rows[0]!
    await insertSections(db, event.id, data.sections)
    return (await withSections(db, [event]))[0]!
  },

  async findById(db: Queryable, id: string): Promise<EventDto | null> {
    const { rows } = await db.query<EventRow>(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1`, [id])
    return rows[0] ? (await withSections(db, rows))[0]! : null
  },

  /**
   * Actualiza un borrador con bloqueo optimista: solo aplica si la versión
   * sigue siendo la que el cliente leyó. Devuelve null si alguien la cambió antes.
   */
  async updateDraft(
    db: Queryable,
    id: string,
    expectedVersion: number,
    patch: EventPatch,
    sections?: SectionInput[],
  ): Promise<EventDto | null> {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof EventPatch, unknown][]
    const sets = entries.map(([key], i) => `${PATCH_COLUMNS[key]} = $${i + 3}`)
    const { rows } = await db.query<EventRow>(
      `UPDATE events
          SET ${[...sets, 'version = version + 1', 'updated_at = now()'].join(', ')}
        WHERE id = $1 AND version = $2 AND status = 'draft'
        RETURNING ${EVENT_COLUMNS}`,
      [id, expectedVersion, ...entries.map(([, v]) => v)],
    )
    if (!rows[0]) return null
    if (sections) {
      await db.query(`DELETE FROM sections WHERE event_id = $1`, [id])
      await insertSections(db, id, sections)
    }
    return (await withSections(db, rows))[0]!
  },

  /**
   * Cambia el estado solo si el actual está en `from`. El WHERE hace que la
   * transición sea atómica: dos "publicar" simultáneos no pueden ganar los dos.
   */
  async transition(db: Queryable, id: string, from: EventStatus[], to: EventStatus): Promise<EventDto | null> {
    const { rows } = await db.query<EventRow>(
      `UPDATE events
          SET status = $3::text,
              version = version + 1,
              updated_at = now(),
              published_at = CASE WHEN $3 = 'published' THEN now() ELSE published_at END,
              cancelled_at = CASE WHEN $3 = 'cancelled' THEN now() ELSE cancelled_at END
        WHERE id = $1 AND status = ANY($2)
        RETURNING ${EVENT_COLUMNS}`,
      [id, from, to],
    )
    return rows[0] ? (await withSections(db, rows))[0]! : null
  },

  /** Paginación por cursor (keyset): estable aunque se inserten eventos y no se degrada con OFFSET grandes. */
  async listPublished(db: Queryable, f: ListFilters): Promise<EventSummary[]> {
    const { rows } = await db.query<EventSummary & { startsAt: Date }>(
      `SELECT e.id, e.title, e.venue_name AS "venueName", e.city, e.starts_at AS "startsAt", e.currency,
              min(s.price_cents)::int AS "minPriceCents",
              sum(s.rows * s.seats_per_row)::int AS capacity
         FROM events e
         JOIN sections s ON s.event_id = e.id
        WHERE e.status = 'published'
          AND e.starts_at >= $1
          AND ($2::timestamptz IS NULL OR e.starts_at < $2)
          AND ($3::text IS NULL OR lower(e.city) = lower($3))
          AND ($4::text IS NULL OR e.title ILIKE $4)
          AND ($5::timestamptz IS NULL OR (e.starts_at, e.id) > ($5, $6::uuid))
        GROUP BY e.id
        ORDER BY e.starts_at, e.id
        LIMIT $7`,
      [
        f.from,
        f.to ?? null,
        f.city ?? null,
        f.q ? `%${escapeLike(f.q)}%` : null,
        f.after?.startsAt ?? null,
        f.after?.id ?? null,
        f.limit,
      ],
    )
    return rows.map((r) => ({ ...r, startsAt: r.startsAt.toISOString() }))
  },

  async listByOrganizer(db: Queryable, organizerId: string): Promise<EventDto[]> {
    const { rows } = await db.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE organizer_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [organizerId],
    )
    return withSections(db, rows)
  },
}
