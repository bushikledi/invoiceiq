import { redirect } from 'next/navigation';

/** The dashboard is the product; the root is just a signpost. */
export default function Home() {
  redirect('/documents');
}
