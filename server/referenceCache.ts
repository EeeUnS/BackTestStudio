import { referenceId, validateReference } from '../src/data/reference.ts';
import { createDataStore } from './dataStore.ts';
import { fetchReference } from './reference.ts';
export function createReferenceStore(directory: string, provider = fetchReference) {
  return createDataStore(directory, { validateKey: key => { referenceId(key); }, validate: validateReference, fetch: provider, identity: (data, key) => data.id === key });
}
