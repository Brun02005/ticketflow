-- Una base de datos por servicio (database-per-service).
-- En producción cada servicio tendría su propia instancia; acá comparten
-- el contenedor para que el entorno local sea liviano.
CREATE DATABASE auth;
CREATE DATABASE auth_test;
CREATE DATABASE events;
CREATE DATABASE events_test;
CREATE DATABASE orders;
CREATE DATABASE orders_test;
CREATE DATABASE payments;
CREATE DATABASE payments_test;
