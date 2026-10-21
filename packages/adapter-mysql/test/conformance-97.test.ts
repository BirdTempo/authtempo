import { MYSQL_SERVERS } from "./db.js";
import { runMysqlSuites } from "./suites.js";

runMysqlSuites(MYSQL_SERVERS[1] as (typeof MYSQL_SERVERS)[number]);
