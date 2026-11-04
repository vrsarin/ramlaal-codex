#!/bin/sh
set -eu

psql --variable=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=forgejo_db="$FORGEJO_DB_NAME" \
  --set=forgejo_user="$FORGEJO_DB_USER" \
  --set=forgejo_password="$FORGEJO_DB_PASSWORD" \
  --set=wikijs_db="$WIKIJS_DB_NAME" \
  --set=wikijs_user="$WIKIJS_DB_USER" \
  --set=wikijs_password="$WIKIJS_DB_PASSWORD" \
  --set=keycloak_db="$KEYCLOAK_DB_NAME" \
  --set=keycloak_user="$KEYCLOAK_DB_USER" \
  --set=keycloak_password="$KEYCLOAK_DB_PASSWORD" <<-'SQL'
	CREATE ROLE :"forgejo_user" LOGIN PASSWORD :'forgejo_password';
	CREATE DATABASE :"forgejo_db" OWNER :"forgejo_user" ENCODING 'UTF8';
	REVOKE CONNECT ON DATABASE :"forgejo_db" FROM PUBLIC;
	GRANT CONNECT ON DATABASE :"forgejo_db" TO :"forgejo_user";

	CREATE ROLE :"wikijs_user" LOGIN PASSWORD :'wikijs_password';
	CREATE DATABASE :"wikijs_db" OWNER :"wikijs_user" ENCODING 'UTF8';
	REVOKE CONNECT ON DATABASE :"wikijs_db" FROM PUBLIC;
	GRANT CONNECT ON DATABASE :"wikijs_db" TO :"wikijs_user";

	CREATE ROLE :"keycloak_user" LOGIN PASSWORD :'keycloak_password';
	CREATE DATABASE :"keycloak_db" OWNER :"keycloak_user" ENCODING 'UTF8';
	REVOKE CONNECT ON DATABASE :"keycloak_db" FROM PUBLIC;
	GRANT CONNECT ON DATABASE :"keycloak_db" TO :"keycloak_user";
SQL
