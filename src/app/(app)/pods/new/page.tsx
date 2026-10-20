import { CreatePodForm } from "@/components/pods/create-pod-form";

export const metadata = {
  title: "Create Pod",
  description: "Create a new photo pod",
};

export default function NewPodPage() {
  return (
    <div className="container max-w-2xl py-8">
      <h1 className="mb-2 text-3xl font-bold">Create a Pod</h1>
      <p className="mb-8 text-muted-foreground">
        Start a shared photo collection for an event, trip, or anything worth remembering.
      </p>
      <CreatePodForm />
    </div>
  );
}
