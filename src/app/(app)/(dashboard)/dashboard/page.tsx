import type { Metadata } from "next";

import { OverviewTabs } from "@/app/(app)/(dashboard)/_components/overview-tabs";
import { RecentSales } from "@/app/(app)/(dashboard)/_components/recent-sales";
import { RevenueChart } from "@/app/(app)/(dashboard)/_components/revenue-chart";
import { StatsCards } from "@/app/(app)/(dashboard)/_components/stats-cards";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { constructMetadata } from "@/config/metadata";
import { getDashboardData } from "./_hooks/use-dashboard-data";

export const metadata: Metadata = constructMetadata({
  title: "Dashboard",
  description: "Your project overview at a glance.",
});

export default async function DashboardPage() {
  const { session } = await getDashboardData();

  return (
    <div className="flex-1 space-y-4 p-4 pt-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-3xl font-bold tracking-tight">
          Welcome back, {session.user.name ?? "friend"}
        </h2>
      </div>

      <StatsCards />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        {/* RevenueChart carries its own card. */}
        <div className="col-span-4">
          <RevenueChart />
        </div>
        <Card className="col-span-3 gap-0 py-0">
          <CardHeader className="p-6 pb-4">
            <CardTitle className="text-sm">Recent sales</CardTitle>
            <CardDescription className="text-xs">265 this month</CardDescription>
          </CardHeader>
          <CardContent className="p-6 pt-0">
            <RecentSales />
          </CardContent>
        </Card>
      </div>

      <OverviewTabs />
    </div>
  );
}
