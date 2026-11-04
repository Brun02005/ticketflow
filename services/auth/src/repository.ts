import { ConflictError, type Queryable, type Role } from '@ticketflow/common'

export type { Role }

export interface User {
  id: string
  email: string
  passwordHash: string
  role: Role
  createdAt: Date
}

export interface RefreshTokenRecord {
  id: string
  userId: string
  familyId: string
  expiresAt: Date
  revokedAt: Date | null
}

const USER_COLUMNS = `id, email, password_hash AS "passwordHash", role, created_at AS "createdAt"`
const TOKEN_COLUMNS = `id, user_id AS "userId", family_id AS "familyId",
  expires_at AS "expiresAt", revoked_at AS "revokedAt"`

const PG_UNIQUE_VIOLATION = '23505'

export const userRepository = {
  async create(db: Queryable, data: { email: string; passwordHash: string; role: Role }) {
    try {
      const { rows } = await db.query<User>(
        `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING ${USER_COLUMNS}`,
        [data.email, data.passwordHash, data.role],
      )
      return rows[0]!
    } catch (err) {
      // Confiamos en el índice único y no en un SELECT previo: dos registros
      // simultáneos con el mismo email no pueden pasar los dos.
      if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new ConflictError('EMAIL_TAKEN', 'Ya existe una cuenta con ese email')
      }
      throw err
    }
  },

  async findByEmail(db: Queryable, email: string) {
    const { rows } = await db.query<User>(`SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1)`, [email])
    return rows[0] ?? null
  },

  async findById(db: Queryable, id: string) {
    const { rows } = await db.query<User>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id])
    return rows[0] ?? null
  },
}

export const refreshTokenRepository = {
  async insert(db: Queryable, data: { userId: string; familyId: string; tokenHash: string; expiresAt: Date }) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [data.userId, data.familyId, data.tokenHash, data.expiresAt],
    )
    return rows[0]!.id
  },

  /** Bloquea la fila hasta el fin de la transacción: dos refresh simultáneos se serializan. */
  async findByHashForUpdate(db: Queryable, tokenHash: string) {
    const { rows } = await db.query<RefreshTokenRecord>(
      `SELECT ${TOKEN_COLUMNS} FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash],
    )
    return rows[0] ?? null
  },

  async markRotated(db: Queryable, id: string, replacedBy: string) {
    await db.query(`UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1`, [id, replacedBy])
  },

  async revokeFamily(db: Queryable, familyId: string) {
    await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [
      familyId,
    ])
  },
}
