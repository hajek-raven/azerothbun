-- `azerothcore/data/sql/create/create_mysql.sql` with the user open to the host, because the server runs outside the container.
-- `mysql_native_password` lets clients log in over a plain local connection without RSA key retrieval.
CREATE USER IF NOT EXISTS 'acore'@'%' IDENTIFIED WITH mysql_native_password BY 'acore';

CREATE DATABASE IF NOT EXISTS `acore_world` DEFAULT CHARACTER SET UTF8MB4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS `acore_characters` DEFAULT CHARACTER SET UTF8MB4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS `acore_auth` DEFAULT CHARACTER SET UTF8MB4 COLLATE utf8mb4_unicode_ci;

GRANT ALL PRIVILEGES ON `acore_world`.* TO 'acore'@'%' WITH GRANT OPTION;
GRANT ALL PRIVILEGES ON `acore_characters`.* TO 'acore'@'%' WITH GRANT OPTION;
GRANT ALL PRIVILEGES ON `acore_auth`.* TO 'acore'@'%' WITH GRANT OPTION;

-- `bun test` creates and drops throwaway `acore_test_*` databases as its own user, so `acore` (and `drizzle-kit pull`)
-- never sees those copies of the auth and characters tables.
CREATE USER IF NOT EXISTS 'acore_test'@'%' IDENTIFIED WITH mysql_native_password BY 'acore_test';
GRANT ALL PRIVILEGES ON `acore\_test\_%`.* TO 'acore_test'@'%';
