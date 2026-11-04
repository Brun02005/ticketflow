-- Fase 6: el outbox guarda el contexto de la traza (traceparent) de quien
-- generó el evento, para que el mensaje la continúe al publicarse.
ALTER TABLE outbox ADD COLUMN headers jsonb NOT NULL DEFAULT '{}';
