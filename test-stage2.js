const { TOOLS } = require('./src/tools');

async function testStage2() {
  console.log('=== Stage 2 Tools Test ===\n');
  
  // Test 1: Validate Tool
  console.log('1. Testing validate tool...');
  try {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number', minimum: 0 }
      },
      required: ['name']
    };
    
    const validData = { name: 'Alice', age: 30 };
    const invalidData = { age: -5 };
    
    const validResult = await TOOLS.sidekick_validate({ data: validData, schema });
    console.log('  ✓ Valid data:', validResult.content[0].text);
    
    const invalidResult = await TOOLS.sidekick_validate({ data: invalidData, schema });
    console.log('  ✓ Invalid data detected:', invalidResult.content[0].text.substring(0, 100));
  } catch (e) {
    console.log('  ✗ Validate test failed:', e.message);
  }
  
  // Test 2: Template Tool
  console.log('\n2. Testing template tool...');
  try {
    const template = 'Hello {{name}}, you are {{age}} years old!';
    const data = { name: 'Bob', age: 25 };
    
    const result = await TOOLS.sidekick_template({ template, data });
    console.log('  ✓ Template rendered:', result.content[0].text);
  } catch (e) {
    console.log('  ✗ Template test failed:', e.message);
  }
  
  // Test 3: Queue Tool
  console.log('\n3. Testing queue tool...');
  try {
    // Clear queue first
    await TOOLS.sidekick_queue({ action: 'clear' });
    
    // Add tasks
    const add1 = await TOOLS.sidekick_queue({ 
      action: 'add', 
      tool: 'sidekick_bash', 
      args: { command: 'echo "Task 1"' },
      priority: 1 
    });
    console.log('  ✓ Added task 1:', add1.content[0].text);
    
    const add2 = await TOOLS.sidekick_queue({ 
      action: 'add', 
      tool: 'sidekick_bash', 
      args: { command: 'echo "Task 2"' },
      priority: 2 
    });
    console.log('  ✓ Added task 2:', add2.content[0].text);
    
    // List tasks
    const list = await TOOLS.sidekick_queue({ action: 'list' });
    console.log('  ✓ Queue list:', list.content[0].text.substring(0, 100));
    
    // Process highest priority task
    const process = await TOOLS.sidekick_queue({ action: 'process' });
    console.log('  ✓ Processed task:', process.content[0].text);
    
    // Clear completed
    await TOOLS.sidekick_queue({ action: 'clear', status: 'completed' });
    console.log('  ✓ Cleared completed tasks');
  } catch (e) {
    console.log('  ✗ Queue test failed:', e.message);
  }
  
  // Test 4: Retry Tool
  console.log('\n4. Testing retry tool...');
  try {
    // Test successful retry (should succeed on first try)
    const successResult = await TOOLS.sidekick_retry({
      tool: 'sidekick_bash',
      args: { command: 'echo "success"' },
      max_attempts: 3,
      initial_delay: 100
    });
    console.log('  ✓ Retry success:', successResult.content[0].text.substring(0, 50));
    
    // Test retry with failure (command that fails)
    const failResult = await TOOLS.sidekick_retry({
      tool: 'sidekick_bash',
      args: { command: 'exit 1' },
      max_attempts: 2,
      initial_delay: 100
    });
    console.log('  ✓ Retry failure detected:', failResult.content[0].text.substring(0, 50));
  } catch (e) {
    console.log('  ✗ Retry test failed:', e.message);
  }
  
  console.log('\n=== Stage 2 Test Complete ===');
}

testStage2().catch(console.error);
