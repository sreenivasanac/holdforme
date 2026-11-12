import { useLocalSearchParams } from 'expo-router';
import { SignInLink } from '../components/SignIn';

/** /signin?token=...: the page of the emailed sign-in link. */
export default function SignInScreen() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  return <SignInLink token={token} />;
}
