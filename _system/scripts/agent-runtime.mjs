import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { StateGraph } from '@langchain/langgraph';

export function checkAgentRuntime() {
  if (typeof StateGraph !== 'function') throw new Error('LangGraph unavailable');
  const saver = SqliteSaver.fromConnString(':memory:');
  try { saver.db.prepare('SELECT 1').get(); }
  finally { saver.db.close(); }
}
