export const load = ({ locals }: { locals: App.Locals }) => ({
  email: locals.session?.user.email ?? null,
});
