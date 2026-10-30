-- Graph store for the ramlaal database; vector/relational memory stays in the same database.
\connect ramlaal
CREATE EXTENSION IF NOT EXISTS age;
LOAD 'age';
SET search_path = ag_catalog, "$user", public;
SELECT create_graph('memory_graph');
