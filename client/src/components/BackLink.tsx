import { useGo } from '../hooks';
import { TextLink } from './ui';

/** "← All calls" */
export function BackLink() {
  const go = useGo();
  return <TextLink label="← All calls" onPress={() => go('/')} />;
}
