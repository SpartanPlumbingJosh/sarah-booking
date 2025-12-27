module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const slots = [];
    
    let date = new Date();
    for (let i = 0; i < 7 && slots.length < 5; i++) {
      date.setDate(date.getDate() + 1);
      if (date.getDay() !== 0 && date.getDay() !== 6) {
        slots.push({
          day: dayNames[date.getDay()],
          date: date.toISOString().split('T')[0],
          windows: ['morning (8-11)', 'midday (11-2)', 'afternoon (2-5)']
        });
      }
    }
    
    const slotText = slots.slice(0, 3).map(s => 
      `${s.day} - morning, midday, or afternoon`
    ).join('. ');
    
    return res.json({
      result: `I've got ${slotText}. What works for you?`,
      slots: slots
    });
    
  } catch (error) {
    return res.json({ 
      result: "We've got morning, midday, and afternoon slots available this week. What works best?" 
    });
  }
};
