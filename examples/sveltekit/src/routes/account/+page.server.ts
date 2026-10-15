// The hook sends a person with no session to /sign-in before this load runs.
export const load = ({ locals }: { locals: App.Locals }) => ({
  email: locals.session?.user.email ?? null,
});
