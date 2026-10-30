# pgvector base plus Apache AGE (graph) built from the PG18 release branch.
FROM pgvector/pgvector:pg18-trixie AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential git ca-certificates bison flex libreadline-dev zlib1g-dev postgresql-server-dev-18 \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch release/PG18/1.7.0 https://github.com/apache/age.git /age \
    && make -C /age install

FROM pgvector/pgvector:pg18-trixie
COPY --from=build /usr/lib/postgresql/18/lib/age.so /usr/lib/postgresql/18/lib/
COPY --from=build /usr/share/postgresql/18/extension/age* /usr/share/postgresql/18/extension/
# AGE must be preloaded for every session that uses cypher().
CMD ["postgres", "-c", "shared_preload_libraries=age"]
