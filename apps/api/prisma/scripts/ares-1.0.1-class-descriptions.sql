-- ARES 1.0.1 — class template descriptions (production-safe, idempotent by name + studio slug)
-- Run against production after review:
--   psql $DATABASE_URL -f apps/api/prisma/scripts/ares-1.0.1-class-descriptions.sql

UPDATE class_templates ct
SET description = v.description,
    updated_at = NOW()
FROM studios s,
     (VALUES
       ('Calirox', 'Un festín entre calistenia y Hyrox. En Calirox encontrarás un entrenamiento basado en fuerza y control corporal combinado con la resistencia y funcionalidad de Hyrox. Sin duda, uno de los favoritos.'),
       ('Street Bars', 'Clase 100% enfocada en técnica y mejora de tu fuerza y control corporal. Aprenderás a controlar tu cuerpo y su fuerza.'),
       ('Hyrox', 'Sesiones personalizadas enfocadas totalmente en las estaciones de Hyrox. Aprenderás a mejorar tu tiempo y eficientar la ejecución de cada ejercicio.'),
       ('Upper Pull', 'Rutina enfocada al grupo muscular seleccionado por día. ARES Method.'),
       ('Upper Push', 'Rutina enfocada al grupo muscular seleccionado por día. ARES Method.')
     ) AS v(name, description)
WHERE ct.studio_id = s.id
  AND s.slug = 'ares-fitness'
  AND ct.name = v.name
  AND ct.deleted_at IS NULL;
