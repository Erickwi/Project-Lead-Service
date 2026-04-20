const axios = require('axios');
require('dotenv').config();

// Basic Auth token (email:api_token → base64)
const authToken = Buffer.from(
  `${process.env.JIRA_EMAIL}:${process.env.JIRA_TOKEN}`
).toString('base64');

const jiraClient = axios.create({
  baseURL: `https://${process.env.JIRA_DOMAIN}/rest/api/3`,
  headers: {
    Authorization:  `Basic ${authToken}`,
    Accept:         'application/json',
    'Content-Type': 'application/json',
  },
});

// Campos a extraer de cada issue
const FIELDS = [
  'summary',
  'status',
  'priority',
  'assignee',
  'comment',
  'timeoriginalestimate',
  'customfield_10037', // Fecha fin / due date
  'customfield_10083', // Revisor interno (QA)
  'customfield_10115', // Revisor operativo (Ops)
];

/**
 * Convierte un nodo ADF (Atlassian Document Format) a markdown simple.
 * Preserva headings (#/##), negrita (**), cursiva (_), listas y saltos de línea.
 * La API v3 de Jira devuelve el cuerpo de comentarios en formato ADF.
 */
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;

  const kids = () => (node.content || []).map(adfToText);

  switch (node.type) {
    case 'doc':
      return kids().join('\n\n').trim();

    case 'paragraph':
      return kids().join('');

    case 'heading': {
      const level = node.attrs?.level || 1;
      return '#'.repeat(Math.min(level, 3)) + ' ' + kids().join('');
    }

    case 'text': {
      let t = node.text || '';
      const marks = node.marks || [];
      if (marks.some(m => m.type === 'strong')) t = `**${t}**`;
      if (marks.some(m => m.type === 'em'))     t = `_${t}_`;
      if (marks.some(m => m.type === 'code'))   t = `\`${t}\``;
      return t;
    }

    case 'hardBreak':
      return '\n';

    case 'bulletList':
      return kids().map(c => `- ${c.trim()}`).join('\n');

    case 'orderedList':
      return kids().map((c, i) => `${i + 1}. ${c.trim()}`).join('\n');

    case 'listItem':
      return kids().join('').trim();

    case 'blockquote':
      return kids().join('').split('\n').map(l => `> ${l}`).join('\n');

    case 'rule':
      return '---';

    case 'mention':
      return node.attrs?.text || '@alguien';

    case 'emoji':
      return node.attrs?.text || '';

    default:
      return kids().join('');
  }
}

/**
 * Pagina automáticamente usando el nuevo endpoint POST /search/jql
 * (GET /rest/api/3/search fue deprecado por Atlassian y devuelve 410 Gone).
 * @param {string} jql
 * @returns {Promise<Array>}
 */
async function fetchJiraIssues(jql) {
  const issues = [];
  let nextPageToken = undefined;
  const maxResults  = 100;

  while (true) {
    const body = { jql, fields: FIELDS, maxResults };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const { data } = await jiraClient.post('/search/jql', body);

    issues.push(...(data.issues || []));

    if (data.isLast || !data.issues || data.issues.length === 0) break;
    nextPageToken = data.nextPageToken;
  }

  return issues;
}

module.exports = { fetchJiraIssues, adfToText };
