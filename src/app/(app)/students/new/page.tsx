import { BackLink } from "@/components/ui";
import { NewStudentForm } from "@/components/forms";

export default function NewStudentPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <BackLink href="/students">Students</BackLink>
      <h1 className="text-2xl font-semibold">New student</h1>
      <NewStudentForm />
    </div>
  );
}
