import {
  InputFieldStat,
  InputTypeStat,
  Trace
} from 'apollo-reporting-protobuf';
import {
  EnumTypeStat,
  EnumValueStat,
  IEnumValueStat,
  IInputFieldStat
} from "apollo-reporting-protobuf/dist/protobuf";
import { VariableValues } from 'apollo-server-types';
import {
  EnumValueNode,
  getNamedType,
  GraphQLInputType,
  GraphQLSchema,
  GraphQLType,
  isEnumType,
  isInputObjectType,
  isInputType,
  isListType,
  isNonNullType,
  isScalarType,
  ObjectFieldNode,
  OperationDefinitionNode,
  typeFromAST,
  TypeInfo,
  visit,
  visitWithTypeInfo
} from "graphql";
import { isCollection, forEach } from 'iterall';

// We would like to inform users about what schema changes are safe, specifically:
// - Can an input object field be safely removed?
// - Can an input object field's type be safely changed to non-nullable?
// - Can an enum value be safely removed?
//
// To give this insight, we need to know whether an operation is using a given
// enum value or input object field (and whether it supplies null at least once
// for that field). This isn't extractable from a given operation signature,
// since signatures hide literals and don't include variable structure (as this
// information can be highly dynamic and/or sensitive). So for each request, we
// summarize just the data we need and add it to the trace.
export function addTraceRequestStats({
  trace,
  schema,
  operation,
  variables,
}: {
  trace: Trace;
  schema: GraphQLSchema;
  operation: OperationDefinitionNode;
  variables?: VariableValues;
}): void {
  try {
    // Search the operation body for input object fields and enum values.
    const typeInfo = new TypeInfo(schema);
    visit(operation, visitWithTypeInfo(typeInfo, {
      ObjectField(node: ObjectFieldNode): void {
        // The operation has been successfully validated by this stage, so the
        // non-null assertions here are fine. Look at the Kind.OBJECT_FIELD case
        // in TypeInfo.enter() in graphql-js for why this works.
        const parentInputType = typeInfo.getParentInputType()!;
        const inputType = typeInfo.getInputType()!;
        inputFieldIsInRequest({
          trace,
          inputObjectTypeName: getNamedType(parentInputType).name,
          inputFieldName: node.name.value,
          inputFieldTypeName: inputType.toString(),
          isNull: node.value.kind === 'NullValue',
        });
      },
      EnumValue(node: EnumValueNode): void {
        // The operation has been successfully validated by this stage, so the
        // non-null assertion here is fine. Look at the Kind.ENUM case in
        // TypeInfo.enter() in graphql-js for why this works.
        const inputType = typeInfo.getInputType()!;
        enumValueIsInRequest({
          trace,
          enumTypeName: getNamedType(inputType).name,
          enumValueName: node.value,
        });
      },
    }));

    // Search the variable values for input object fields and enum values. This
    // code is adapted from coerceVariableValues() in graphql-js.
    for (const varDefinition of operation.variableDefinitions ?? []) {
      const varName = varDefinition.variable.name.value;

      // TS unfortunately doesn't handle overloads and union types as nicely as
      // Flow, see https://github.com/microsoft/TypeScript/issues/14107
      let varType: GraphQLType | undefined;
      switch (varDefinition.type.kind) {
        case 'ListType':
          varType = typeFromAST(schema, varDefinition.type);
          break;
        case 'NamedType':
          varType = typeFromAST(schema, varDefinition.type);
          break;
        case 'NonNullType':
          varType = typeFromAST(schema, varDefinition.type);
          break;
      }

      if (!varType || !isInputType(varType)) {
        throw Error('Variable type must be input type.');
      }

      if (!Object.prototype.hasOwnProperty.call(variables, varName)) {
        if (!varDefinition.defaultValue && isNonNullType(varType)) {
          throw Error('Non-null variable with no default must have value provided.');
        }
        continue;
      }

      const value = variables?.[varName];
      if (value === null && isNonNullType(varType)) {
        throw Error('Non-null variable cannot be provided null value.');
      }

      addTraceInputValueStats({
        trace,
        inputValue: value,
        inputType: varType,
      });
    }
  } catch (_) {
    // At the stage of AS when this is run, variables have not been validated
    // yet, and accordingly the code that traverses variables may throw. In
    // those cases, we consider the request itself as invalid. Since the point
    // of collecting these stats is to understand how schema changes affect
    // valid operation executions, we collect no stats for invalid requests.
    trace.perInputTypeStat = Object.create(null);
    trace.perEnumTypeStat = Object.create(null);
  }
}

// This code is adapted from coerceInputValue() in graphql-js. Note that we
// validate the variables here in addition to collecting stats, as variable
// validation errors aren't easy to determine in the didEncounterErrors() hook.
function addTraceInputValueStats({
  trace,
  inputValue,
  inputType,
}: {
  trace: Trace;
  inputValue: any;
  inputType: GraphQLInputType;
}): void {
  if (isNonNullType(inputType)) {
    if (inputValue !== null) {
      addTraceInputValueStats({
        trace,
        inputValue,
        inputType: inputType.ofType,
      })
      return;
    }
    throw Error('Non-null type cannot be provided null value.');
  }

  // Provided null for nullable type.
  if (inputValue === null) return;

  if (isListType(inputType)) {
    const itemType = inputType.ofType;
    if (isCollection(inputValue)) {
      const iterator = (itemValue: any) => {
        addTraceInputValueStats({
          trace,
          inputValue: itemValue,
          inputType: itemType,
        });
      }
      // TS unfortunately doesn't handle overloads and union types as nicely as
      // Flow, see https://github.com/microsoft/TypeScript/issues/14107
      if ('length' in inputValue) {
        forEach(inputValue, iterator);
      } else {
        forEach(inputValue, iterator);
      }
    } else {
      // Lists accept a non-list value as a list of one.
      addTraceInputValueStats({
        trace,
        inputValue,
        inputType: itemType,
      });
    }
    return;
  }

  if (isInputObjectType(inputType)) {
    if (typeof inputValue !== 'object') {
      throw Error('Input object type must be provided object value.');
    }
    const inputFields = inputType.getFields();

    for (const inputField of Object.values(inputFields)) {
      const inputFieldValue = inputValue[inputField.name];

      if (inputFieldValue === undefined) {
        if (inputField.defaultValue === undefined && isNonNullType(inputField.type)) {
          throw Error('Non-null input field with no default must have value provided.');
        }
        continue;
      }

      inputFieldIsInRequest({
        trace,
        inputObjectTypeName: inputType.name,
        inputFieldName: inputField.name,
        inputFieldTypeName: inputField.type.toString(),
        isNull: inputFieldValue === null,
      });

      addTraceInputValueStats({
        trace,
        inputValue: inputFieldValue,
        inputType: inputField.type,
      });
    }

    // Ensure every provided field is defined.
    for (const fieldName of Object.keys(inputValue)) {
      if (!inputFields[fieldName]) {
        throw Error('Input object type does not have provided field name.');
      }
    }
    return;
  }

  if (isScalarType(inputType)) {
    let parseResult;

    // Scalars determine if an input value is valid via parseValue(), which can
    // throw to indicate failure.
    try {
      parseResult = inputType.parseValue(inputValue);
    } catch (error) {
      throw Error('Scalar type threw while parsing provided value.');
    }
    if (parseResult === undefined) {
      throw Error('Scalar type returned undefined when parsing provided value.');
    }
    return;
  }

  if (isEnumType(inputType)) {
    if (typeof inputValue === 'string') {
      const enumValue = inputType.getValue(inputValue);
      if (enumValue) {
        enumValueIsInRequest({
          trace,
          enumTypeName: inputType.name,
          enumValueName: enumValue.name,
        });
        return;
      }
    }
    throw Error('Enum type does not have provided enum value.');
  }

  // Not reachable. All possible input types have been considered.
  throw Error('Unexpected input type.');
}

function inputFieldIsInRequest({
  trace,
  inputObjectTypeName,
  inputFieldName,
  inputFieldTypeName,
  isNull,
}: {
  trace: Trace;
  inputObjectTypeName: string;
  inputFieldName: string;
  inputFieldTypeName: string;
  isNull: boolean;
}): void {
  const inputTypeStat =
    Object.prototype.hasOwnProperty.call(trace.perInputTypeStat, inputObjectTypeName)
      ? trace.perInputTypeStat[inputObjectTypeName]
      : (trace.perInputTypeStat[inputObjectTypeName] = new InputTypeStat());
  const perInputFieldStat = inputTypeStat.perInputFieldStat
    ?? (inputTypeStat.perInputFieldStat = Object.create(null));
  const inputFieldStat: IInputFieldStat =
    Object.prototype.hasOwnProperty.call(perInputFieldStat, inputFieldName)
      ? perInputFieldStat[inputFieldName]
      : (perInputFieldStat[inputFieldName] = new InputFieldStat());
  inputFieldStat.fieldType = inputFieldTypeName;
  inputFieldStat.requestCount = 1;
  if (isNull) inputFieldStat.requestCountNull = 1;
}

function enumValueIsInRequest({
  trace,
  enumTypeName,
  enumValueName,
}: {
  trace: Trace;
  enumTypeName: string;
  enumValueName: string;
}): void {
  const enumTypeStat =
    Object.prototype.hasOwnProperty.call(trace.perEnumTypeStat, enumTypeName)
      ? trace.perEnumTypeStat[enumTypeName]
      : (trace.perEnumTypeStat[enumTypeName] = new EnumTypeStat());
  const perEnumValueStat = enumTypeStat.perEnumValueStat
    ?? (enumTypeStat.perEnumValueStat = Object.create(null));
  const enumValueStat: IEnumValueStat =
    Object.prototype.hasOwnProperty.call(perEnumValueStat, enumValueName)
      ? perEnumValueStat[enumValueName]
      : (perEnumValueStat[enumValueName] = new EnumValueStat());
  enumValueStat.requestCount = 1;
}
