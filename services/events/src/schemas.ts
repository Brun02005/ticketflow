import { type Static, Type } from '@ticketflow/common'

const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) => Type.Union([schema, Type.Null()])

export const EventStatus = Type.Union([Type.Literal('draft'), Type.Literal('published'), Type.Literal('cancelled')])
export type EventStatus = Static<typeof EventStatus>

const Currency = Type.Union([Type.Literal('ARS'), Type.Literal('USD')])

export const SectionInput = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 60 }),
  priceCents: Type.Integer({ minimum: 0, maximum: 100_000_000, description: 'Precio en centavos' }),
  rows: Type.Integer({ minimum: 1, maximum: 100 }),
  seatsPerRow: Type.Integer({ minimum: 1, maximum: 200 }),
})
export type SectionInput = Static<typeof SectionInput>

const Sections = Type.Array(SectionInput, { minItems: 1, maxItems: 20 })

const EditableFields = {
  title: Type.String({ minLength: 3, maxLength: 140 }),
  description: Type.String({ maxLength: 5000 }),
  venueName: Type.String({ minLength: 1, maxLength: 140 }),
  city: Type.String({ minLength: 1, maxLength: 80 }),
  startsAt: Type.String({ format: 'date-time' }),
  currency: Currency,
  sections: Sections,
}

export const CreateEventBody = Type.Object({
  ...EditableFields,
  description: Type.Optional(EditableFields.description),
  currency: Type.Optional(Currency),
})
export type CreateEventInput = Static<typeof CreateEventBody>

export const UpdateEventBody = Type.Object(
  {
    version: Type.Integer({ minimum: 1, description: 'Versión que leíste; si cambió, responde 409' }),
    title: Type.Optional(EditableFields.title),
    description: Type.Optional(EditableFields.description),
    venueName: Type.Optional(EditableFields.venueName),
    city: Type.Optional(EditableFields.city),
    startsAt: Type.Optional(EditableFields.startsAt),
    currency: Type.Optional(Currency),
    sections: Type.Optional(Sections),
  },
  { minProperties: 2 },
)
export type UpdateEventInput = Static<typeof UpdateEventBody>

export const SectionSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  priceCents: Type.Integer(),
  rows: Type.Integer(),
  seatsPerRow: Type.Integer(),
  capacity: Type.Integer(),
})
export type Section = Static<typeof SectionSchema>

export const EventSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  organizerId: Type.String({ format: 'uuid' }),
  title: Type.String(),
  description: Type.String(),
  venueName: Type.String(),
  city: Type.String(),
  startsAt: Type.String({ format: 'date-time' }),
  currency: Currency,
  status: EventStatus,
  version: Type.Integer(),
  capacity: Type.Integer(),
  sections: Type.Array(SectionSchema),
  publishedAt: Nullable(Type.String({ format: 'date-time' })),
  cancelledAt: Nullable(Type.String({ format: 'date-time' })),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
})
export type EventDto = Static<typeof EventSchema>

export const EventSummarySchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  title: Type.String(),
  venueName: Type.String(),
  city: Type.String(),
  startsAt: Type.String({ format: 'date-time' }),
  currency: Currency,
  minPriceCents: Type.Integer(),
  capacity: Type.Integer(),
})
export type EventSummary = Static<typeof EventSummarySchema>

export const ListEventsQuery = Type.Object({
  limit: Type.Integer({ minimum: 1, maximum: 100, default: 20 }),
  cursor: Type.Optional(Type.String({ maxLength: 200 })),
  city: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  q: Type.Optional(Type.String({ minLength: 2, maxLength: 100, description: 'Búsqueda parcial en el título' })),
  from: Type.Optional(Type.String({ format: 'date-time', description: 'Por defecto: ahora' })),
  to: Type.Optional(Type.String({ format: 'date-time' })),
})
export type ListEventsQuery = Static<typeof ListEventsQuery>

export const EventListSchema = Type.Object({
  items: Type.Array(EventSummarySchema),
  nextCursor: Nullable(Type.String()),
})

export const OrganizerEventListSchema = Type.Object({ items: Type.Array(EventSchema) })

export const EventIdParams = Type.Object({ id: Type.String({ format: 'uuid' }) })
