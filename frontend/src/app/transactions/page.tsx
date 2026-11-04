/* Transactions home redirects to Sales; Sales and Expenses live on
   their own pages under /transactions. */
import { redirect } from "next/navigation";

export default function TransactionsIndex() {
  redirect("/transactions/sales");
}
