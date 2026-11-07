import { redirect } from "next/navigation";

// The student list is the home page. Signed-out visitors are sent on to /login from there.
export default function Home() {
  redirect("/students");
}
