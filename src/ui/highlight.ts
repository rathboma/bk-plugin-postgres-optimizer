/** A tiny SQL highlighter for read-only code blocks. Returns escaped HTML. */

const KEYWORDS = new Set(
  (
    "select from where and or not in is null as on join left right inner outer full cross lateral " +
    "group by order having limit offset with recursive union all distinct insert into values update set " +
    "delete returning create index concurrently unique table alter column type drop if exists using " +
    "primary key references foreign constraint check default analyze explain vacuum verbose freeze " +
    "reindex sequence system extension begin commit rollback local case when then else end asc desc " +
    "nulls first last true false between like ilike any some exists cast interval grant to add " +
    "validate reset generated always identity bigint int integer text statistics prepared"
  ).split(" "),
);

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const TOKEN =
  /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(\$\d+)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_$]*)/g;

export function highlightSql(sql: string): string {
  let out = "";
  let last = 0;
  for (const m of sql.matchAll(TOKEN)) {
    out += escape(sql.slice(last, m.index));
    const [text, comment, str, quoted, param, num, word] = m;
    if (comment) out += `<span class="cmt">${escape(text)}</span>`;
    else if (str) out += `<span class="str">${escape(text)}</span>`;
    else if (quoted) out += escape(text);
    else if (param) out += `<span class="param">${escape(text)}</span>`;
    else if (num) out += `<span class="num">${escape(text)}</span>`;
    else if (word && KEYWORDS.has(word.toLowerCase())) out += `<span class="kw">${escape(text)}</span>`;
    else out += escape(text);
    last = m.index! + text.length;
  }
  return out + escape(sql.slice(last));
}

/**
 * pg_stat_statements stores queries on one line as typed. Put clause keywords
 * on their own lines so long queries are readable.
 */
export function prettySql(sql: string): string {
  if (sql.includes("\n")) return sql.trim();
  return sql
    .replace(/\s+/g, " ")
    .replace(
      /\s+(FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|UNION(?: ALL)?|(?:LEFT |RIGHT |INNER |FULL |CROSS )?(?:OUTER )?JOIN|RETURNING|VALUES|SET)\s+/gi,
      "\n$1 ",
    )
    .replace(/\s+(AND|OR)\s+/g, "\n  $1 ")
    .trim();
}
