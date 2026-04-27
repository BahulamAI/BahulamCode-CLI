interface Props {
  current: number
  longest: number
  totalActiveDays: number
  mostActiveDay: string
  mostActiveDayMsgs: number
}

export function StreakCard({ current, longest, totalActiveDays, mostActiveDay, mostActiveDayMsgs }: Props) {
  return (
    <div className="grid grid-cols-2 gap-3 text-[13px]">
      <div className="border border-border rounded p-3 bg-card">
        <p className="text-muted-foreground uppercase tracking-wider text-[12px] mb-1">Current Streak</p>
        <p className="text-2xl font-bold text-primary">{current}</p>
        <p className="text-muted-foreground/60 text-[12px]">consecutive days</p>
      </div>
      <div className="border border-border rounded p-3 bg-card">
        <p className="text-muted-foreground uppercase tracking-wider text-[12px] mb-1">Longest Streak</p>
        <p className="text-2xl font-bold text-blue-700 dark:text-[#60a5fa]">{longest}</p>
        <p className="text-muted-foreground/60 text-[12px]">consecutive days</p>
      </div>
      <div className="border border-border rounded p-3 bg-card">
        <p className="text-muted-foreground uppercase tracking-wider text-[12px] mb-1">Active Days</p>
        <p className="text-2xl font-bold text-foreground">{totalActiveDays}</p>
        <p className="text-muted-foreground/60 text-[12px]">total days with activity</p>
      </div>
      {mostActiveDay && (
        <div className="border border-border rounded p-3 bg-card">
          <p className="text-muted-foreground uppercase tracking-wider text-[12px] mb-1">Most Active Day</p>
          <p className="text-sm font-bold text-[#34d399]">{mostActiveDay}</p>
          <p className="text-muted-foreground/60 text-[12px]">{mostActiveDayMsgs.toLocaleString()} messages</p>
        </div>
      )}
    </div>
  )
}
