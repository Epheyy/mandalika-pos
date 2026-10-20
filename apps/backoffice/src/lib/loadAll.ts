import { fetchAllPages, type Ingredient, type ListResult, type Product } from '@mandalika/api'

type Lister<T> = (page: number, limit: number) => Promise<ListResult<T>>

// The backend caps a page at 200, so pickers and in-memory lists that need every
// row must page through fetchAllPages rather than ask for one big page.
export const loadAllProducts = (list: Lister<Product>) => fetchAllPages(list)

export const loadAllIngredients = (list: Lister<Ingredient>) => fetchAllPages(list)
