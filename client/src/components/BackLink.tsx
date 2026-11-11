import { router } from 'expo-router';
import { TextLink } from './ui';

/** "← All calls" */
export function BackLink() {
  return <TextLink label="← All calls" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />;
}
