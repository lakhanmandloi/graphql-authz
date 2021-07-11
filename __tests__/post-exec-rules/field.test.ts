import { GraphQLSchema, printSchema } from 'graphql';

import { authZApolloPlugin, authZDirective } from '../../src';
import { ApolloServerMock } from '../apollo-server-mock';
import { syncRules } from './rules-sync';
import { asyncRules } from './rules-async';

const rawSchema = `
type Post {
  id: ID!
  title(arg: String): String! @authz(rules: [FailingPostExecRule])
  owner: User!
}

type User {
  id: ID!
  email: String @authz(rules: [PassingPostExecRuleWithSelectionSet])
  posts: [Post]
  comments: [Comment]
}

type Comment {
  id: ID!
  text: String! @authz(rules: [SecondPassingPostExecRule])
  owner: User!
  post: Post
}

type Query {
  post: Post
  user: User
}
`;

const postQuery = `
  query getPost {
    post {
      id
    }
  }
`;

const postWithTitleQuery = `
  query getPost {
    post {
      id
      title(arg: "test_argument")
    }
  }
`;

const userQuery = `
  query getUser {
    user {
      id
      email
    }
  }
`;

const userWithPostsQuery = `
query getUser {
  user {
    id
    email
    posts {
      id
    }
  }
}
`;

const userWithPostTitleQuery = `
query getUser {
  user {
    id
    email
    posts {
      id
      title
    }
  }
}
`;

const userWithCommentsQuery = `
query getUser {
  user {
    id
    email
    comments {
      id
      text
    }
  }
}
`;

describe.each([
  ['sync', syncRules],
  ['async', asyncRules]
])('%s', (name, rules) => {
  describe('post execution rule', () => {
    describe('on object', () => {
      let server: ApolloServerMock;
      let typeDefs: string;

      beforeAll(async () => {
        const plugin = authZApolloPlugin(rules);
        const directive = authZDirective(rules);
        const directiveSchema = new GraphQLSchema({
          directives: [directive]
        });

        typeDefs = `${printSchema(directiveSchema)}
        ${rawSchema}`;

        server = new ApolloServerMock({
          typeDefs,
          mocks: true,
          mockEntireSchema: true,
          plugins: [plugin]
        });
        await server.willStart();
      });

      afterEach(() => {
        jest.clearAllMocks();
      });

      it('should execute affected rule', async () => {
        await server
          .executeOperation({
            query: postWithTitleQuery
          })
          .catch(e => e);

        const ruleArgs =
          // @ts-expect-error
          rules.FailingPostExecRule.prototype.execute.mock.calls[0];

        expect(rules.FailingPostExecRule.prototype.execute).toBeCalled();
        expect(rules.FailingPostExecRule.prototype.execute).toBeCalledTimes(1);
        expect(ruleArgs[1]).toEqual({ arg: 'test_argument' });
      });

      it('rules should receive result value and parent value', async () => {
        await server
          .executeOperation({
            query: postWithTitleQuery
          })
          .catch(e => e);

        const failingRuleArgs =
          // @ts-expect-error
          rules.FailingPostExecRule.prototype.execute.mock.calls[0];

        expect(failingRuleArgs[0]).toBeDefined();
        expect(failingRuleArgs[1]).toBeDefined();
        expect(failingRuleArgs[2]).toBeDefined();
        expect(failingRuleArgs[3]).toHaveProperty('id');
        expect(failingRuleArgs[3]).toHaveProperty('title');
        expect(failingRuleArgs[3].title).toEqual(failingRuleArgs[2]);

        const result = await server
          .executeOperation({
            query: userQuery
          })
          .catch(e => e);

        const passingRuleArgs =
          // @ts-expect-error
          rules.PassingPostExecRuleWithSelectionSet.prototype.execute.mock
            .calls[0];

        expect(passingRuleArgs[0]).toBeDefined();
        expect(passingRuleArgs[1]).toBeDefined();
        expect(passingRuleArgs[2]).toBeDefined();
        expect(passingRuleArgs[3]).toHaveProperty('id');
        expect(passingRuleArgs[3]).toHaveProperty('email');
        expect(passingRuleArgs[3]).toHaveProperty('comments');

        passingRuleArgs[3].comments.forEach((comment: unknown) => {
          expect(comment).toHaveProperty('id');
          expect(comment).toHaveProperty('text');
        });

        expect(passingRuleArgs[3].email).toEqual(passingRuleArgs[2]);

        expect(result?.data?.user).toBeDefined();
        expect(result?.data?.user).not.toHaveProperty('comments');
      });

      it('should not execute not affected rule', async () => {
        await server.executeOperation({
          query: userQuery
        });

        await server.executeOperation({
          query: postQuery
        });

        await server.executeOperation({
          query: userWithPostsQuery
        });

        expect(rules.FailingPostExecRule.prototype.execute).not.toBeCalled();
      });

      it('failing rule should fail query', async () => {
        let result;
        let error;
        try {
          result = await server.executeOperation({
            query: postWithTitleQuery
          });
        } catch (e) {
          error = e;
        }

        expect(result).toBeUndefined();
        expect(error).toBeDefined();
        expect(error.extensions.code).toEqual('FORBIDDEN');
      });

      it('passing rule should not fail query', async () => {
        let result;
        let error;
        try {
          result = await server.executeOperation({
            query: userQuery
          });
        } catch (e) {
          error = e;
        }

        expect(error).toBeUndefined();
        expect(result?.errors).toBeUndefined();
        expect(result?.data).toBeDefined();
      });

      it('rule should be executed for nested entity', async () => {
        let result;
        let error;
        try {
          result = await server.executeOperation({
            query: userWithPostTitleQuery
          });
        } catch (e) {
          error = e;
        }

        expect(result).toBeUndefined();
        expect(error).toBeDefined();
        expect(error.extensions.code).toEqual('FORBIDDEN');
      });

      it('rules from nested entity should receive result value and parent value', async () => {
        await server.executeOperation({
          query: userWithCommentsQuery
        });

        // apollo-server returns mocked result with 2 items in array
        expect(
          rules.SecondPassingPostExecRule.prototype.execute
        ).toBeCalledTimes(2);

        // @ts-expect-error
        rules.SecondPassingPostExecRule.prototype.execute.mock.calls.forEach(
          (args: [unknown, unknown, unknown, { text: string }]) => {
            expect(args[0]).toBeDefined();
            expect(args[1]).toBeDefined();
            expect(args[2]).toBeDefined();

            expect(args[3]).toHaveProperty('id');
            expect(args[3]).toHaveProperty('text');

            expect(args[3].text).toEqual(args[2]);
          }
        );
      });

      it('should skip fields with @skip(if: true) directive', async () => {
        const result = await server.executeOperation({
          query: `query getUser($shouldSkip: Boolean!) {
            user {
              id
              email @skip(if: $shouldSkip)
            }
          }`,
          variables: {
            shouldSkip: true
          }
        });

        expect(
          rules.PassingPostExecRuleWithSelectionSet.prototype.execute
        ).not.toBeCalled();
        expect(result?.data?.user).toBeDefined();
        expect(result?.data?.user).not.toHaveProperty('email');
      });

      it('should not skip fields with @skip(if: false) directive', async () => {
        const result = await server.executeOperation({
          query: `query getUser($shouldSkip: Boolean!) {
            user {
              id
              email @skip(if: $shouldSkip)
            }
          }`,
          variables: {
            shouldSkip: false
          }
        });

        expect(
          rules.PassingPostExecRuleWithSelectionSet.prototype.execute
        ).toBeCalled();
        expect(result?.data?.user).toBeDefined();
        expect(result?.data?.user).toHaveProperty('email');

        const passingRuleArgs =
          // @ts-expect-error
          rules.PassingPostExecRuleWithSelectionSet.prototype.execute.mock
            .calls[0];

        expect(passingRuleArgs[2]).toBeDefined();
        expect(passingRuleArgs[3]).toHaveProperty('email');
      });

      it('should skip fields with @include(if: false) directive', async () => {
        const result = await server.executeOperation({
          query: `query getUser($shouldInclude: Boolean!) {
            user {
              id
              email @include(if: $shouldInclude)
            }
          }`,
          variables: {
            shouldInclude: false
          }
        });

        expect(
          rules.PassingPostExecRuleWithSelectionSet.prototype.execute
        ).not.toBeCalled();
        expect(result?.data?.user).toBeDefined();
        expect(result?.data?.user).not.toHaveProperty('email');
      });

      it('should not skip fields with @include(if: true) directive', async () => {
        const result = await server.executeOperation({
          query: `query getUser($shouldInclude: Boolean!) {
            user {
              id
              email @include(if: $shouldInclude)
            }
          }`,
          variables: {
            shouldInclude: true
          }
        });

        expect(
          rules.PassingPostExecRuleWithSelectionSet.prototype.execute
        ).toBeCalled();
        expect(result?.data?.user).toBeDefined();
        expect(result?.data?.user).toHaveProperty('email');

        const passingRuleArgs =
          // @ts-expect-error
          rules.PassingPostExecRuleWithSelectionSet.prototype.execute.mock
            .calls[0];

        expect(passingRuleArgs[2]).toBeDefined();
        expect(passingRuleArgs[3]).toHaveProperty('email');
      });

      it('should handle fragments', async () => {
        await server.executeOperation({
          query: `query getUser {
            user {
              id
              ...Fragment1
            }
          }
          fragment Fragment1 on User {
            ...Fragment2
          }
          fragment Fragment2 on User {
            email
          }
          `
        });

        expect(
          rules.PassingPostExecRuleWithSelectionSet.prototype.execute
        ).toBeCalled();

        const passingRuleArgs =
          // @ts-expect-error
          rules.PassingPostExecRuleWithSelectionSet.prototype.execute.mock
            .calls[0];

        expect(passingRuleArgs[2]).toBeDefined();
        expect(passingRuleArgs[3]).toHaveProperty('email');
      });

      it('should handle aliases', async () => {
        await server.executeOperation({
          query: `query getUser {
            user {
              id
              emailAlias: email
            }
          }
          `
        });

        expect(
          rules.PassingPostExecRuleWithSelectionSet.prototype.execute
        ).toBeCalled();

        const passingRuleArgs =
          // @ts-expect-error
          rules.PassingPostExecRuleWithSelectionSet.prototype.execute.mock
            .calls[0];

        expect(passingRuleArgs[2]).toBeDefined();
        expect(passingRuleArgs[3]).toHaveProperty('emailAlias');
      });

      it('should handle aliases in fragments', async () => {
        await server.executeOperation({
          query: `query getUser {
            user {
              id
              ...Fragment1
            }
          }
          fragment Fragment1 on User {
            ...Fragment2
          }
          fragment Fragment2 on User {
            emailAlias: email
          }
          `
        });

        expect(
          rules.PassingPostExecRuleWithSelectionSet.prototype.execute
        ).toBeCalled();

        const passingRuleArgs =
          // @ts-expect-error
          rules.PassingPostExecRuleWithSelectionSet.prototype.execute.mock
            .calls[0];

        expect(passingRuleArgs[2]).toBeDefined();
        expect(passingRuleArgs[3]).toHaveProperty('emailAlias');
      });
    });
  });
});
