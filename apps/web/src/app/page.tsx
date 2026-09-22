import Home from "@/components/home";
import { accessScreen } from "@/lib/page-access";
export const dynamic = "force-dynamic";
export default async function Page() {
  return (await accessScreen()) ?? <Home />;
}
