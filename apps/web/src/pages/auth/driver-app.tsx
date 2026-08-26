import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@plastago/ui';
import { TruckIcon } from 'lucide-react';
import { useAuth } from '@/features/auth/auth-context';

/**
 * Where a driver lands if they sign in here.
 *
 * The driver app is a SEPARATE Vite build (§6A.5) — its service worker and
 * offline shell need their own configuration — so a driver reaching this app
 * cannot simply be routed onwards. A bare 403 would be wrong and unhelpful: they
 * have a valid account, they are just at the wrong address, which is an easy
 * mistake when both are links in an SMS.
 */
export function DriverAppPage() {
  const { user, signOut } = useAuth();

  return (
    <Card>
      <CardHeader>
        <div className="mb-1 grid size-10 place-items-center rounded-full bg-accent text-accent-foreground">
          <TruckIcon aria-hidden className="size-5" />
        </div>
        <CardTitle className="text-lg">Drivers use the PlastaGo Driver app</CardTitle>
        <CardDescription>
          {user ? `You’re signed in as ${user.name}, ` : ''}and your run sheet, photos and job
          updates all live in the driver app — it keeps working when you have no signal.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Open it from the link the office sent you, or add it to your home screen so it is one tap
          away.
        </p>

        <Button variant="outline" className="w-full" onClick={() => void signOut()}>
          Sign out
        </Button>
      </CardContent>
    </Card>
  );
}
