import { useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLogoutMutation, useSessionQuery } from '@/auth/use-session';

/**
 * The header's account control — the "user / sign-out menu" the app shell
 * carries alongside ⌘K search and the notification bell. Sign out lives
 * inside this dropdown rather than as a bare header button (the pre-v0.1
 * shell) so the top bar stays slim.
 *
 * The signed-in admin's email is the trigger's own visible text — which
 * keeps it the trigger's accessible name (both leading icons are
 * `aria-hidden`), so nothing here trips WCAG 2.5.3 "Label in Name". On a
 * narrow header the email collapses to screen-reader-only rather than
 * `display:none`, so the trigger still has an accessible name on every
 * viewport.
 */
export function AccountMenu() {
  const navigate = useNavigate();
  const session = useSessionQuery();
  const logoutMutation = useLogoutMutation();
  const email = session.data?.admin.email ?? '';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="max-w-[16rem] gap-2">
          <User className="size-4 text-text-secondary" aria-hidden="true" />
          <span className="sr-only max-w-[12rem] truncate text-text-secondary sm:not-sr-only">
            {email}
          </span>
          <ChevronDown className="size-3.5 text-text-muted" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="text-caption font-normal text-text-muted">Signed in as</span>
          <span className="truncate text-body-sm text-text-primary">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() =>
            logoutMutation.mutate(undefined, {
              onSuccess: () => navigate('/login', { replace: true }),
            })
          }
        >
          <LogOut className="size-4" aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
