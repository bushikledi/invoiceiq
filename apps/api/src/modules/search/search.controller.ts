import { Controller, Get } from '@nestjs/common';
import {
  SearchQuerySchema,
  type AuthenticatedUser,
  type SearchQuery,
  type SearchResponse,
} from '@invoiceiq/contracts';
import { CurrentUser } from '../auth/auth.decorators.js';
import { ZodQuery } from '../../common/validation/zod-validation.pipe.js';
import { SearchService } from './search.service.js';

@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  run(
    @CurrentUser() user: AuthenticatedUser,
    @ZodQuery(SearchQuerySchema) query: SearchQuery,
  ): Promise<SearchResponse> {
    return this.search.search(user.id, query.q, query.limit);
  }
}
