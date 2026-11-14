import { Redirect } from 'expo-router';
import { PeopleCard } from '../components/People';
import { Screen } from '../components/ui';
import { useSession } from '../hooks';

/** People (admin only): usage, disable / enable / remove, sign-ups. Others go to Calls, as for an unknown page. */
export default function PeopleScreen() {
  const { me } = useSession();
  if (!me?.is_admin) return <Redirect href="/" />;
  return (
    <Screen>
      <PeopleCard />
    </Screen>
  );
}
